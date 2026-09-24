/**
 * `AnalystAgent` - the on-demand half of the copilot.
 *
 * The whole pipeline is: question -> intent (model) -> compile (code) ->
 * execute (code) -> narrate (model). Two model calls at the ends, deterministic
 * code in the middle, and every answer carries the intent and the pipelines
 * that produced it so a reader can check the work.
 *
 * It is a Durable Object rather than a stateless handler for two concrete
 * reasons: the MongoDB client owns sockets that must live in one I/O context
 * (see `db/driver.ts`), and follow-up questions patch the previous intent
 * instead of re-deriving it.
 */
import { Agent } from "agents";
import { createDriverDataSource } from "../db/driver";
import type { DataSource } from "../db/types";
import type { QueryIntent } from "../semantic/intent";
import { execute, type ResultSet, type ResultRow } from "../semantic/execute";
import { applyChartChoice, chartTypeIsNegotiable, suggestChart, type ChartSpec } from "../semantic/chart";
import { formatValue } from "../semantic/metrics";
import { fmtDay, type DateRange } from "../semantic/dates";
import { createProvider, refusalMessage, type LLMProvider } from "../llm";

export interface Env {
  AnalystAgent: DurableObjectNamespace<AnalystAgent>;
  AI: Ai;
  MONGODB_URI: string;
  MONGODB_DB_NAME: string;
  DATA_PATH_MODE: "bridge" | "driver";
  BRIDGE_URL: string;
  LLM_PROVIDER: "claude" | "workers-ai";
  ANTHROPIC_API_KEY: string;
}

export interface AnalystState {
  /** Conversation so far, rendered in the UI. */
  messages: { role: "user" | "assistant"; text: string; at: string }[];
  /**
   * The last `QueryIntent` this session compiled. Follow-ups like "now break
   * that by city" clone this and patch one field.
   */
  lastIntent: QueryIntent | null;
}

export interface AnswerTable {
  columns: { key: string; label: string }[];
  rows: Record<string, string>[];
}

export type AnalystAnswer =
  | {
      ok: true;
      question: string;
      headline: string;
      narrative: string;
      chart: ChartSpec;
      table: AnswerTable;
      /** The audit trail: what was asked of the database, and why. */
      intent: QueryIntent;
      queries: ResultSet["meta"]["queries"];
      notes: string[];
      timings: { planMs: number; queryMs: number; narrateMs: number; totalMs: number };
    }
  | { ok: false; kind: "refusal"; question: string; reason: string; suggestion: string; message: string }
  | { ok: false; kind: "error"; question: string; message: string };

const INITIAL: AnalystState = { messages: [], lastIntent: null };

export class AnalystAgent extends Agent<Env, AnalystState> {
  initialState = INITIAL;

  private ds: DataSource | null = null;
  private llm: LLMProvider | null = null;
  private window: DateRange | null = null;

  private data(): DataSource {
    return (this.ds ??= createDriverDataSource(this.env.MONGODB_URI, this.env.MONGODB_DB_NAME));
  }

  private provider(): LLMProvider {
    return (this.llm ??= createProvider(this.env));
  }

  /**
   * The span the data actually covers, read from the data rather than from a
   * constant. A hardcoded window silently goes stale the first time anyone
   * regenerates the foundry.
   */
  private async dataWindow(): Promise<DateRange> {
    if (this.window) return this.window;
    const [first, last] = await Promise.all([
      this.data().aggregate("leads", [{ $sort: { created_at: 1 } }, { $limit: 1 }, { $project: { created_at: 1 } }]),
      this.data().aggregate("leads", [{ $sort: { created_at: -1 } }, { $limit: 1 }, { $project: { created_at: 1 } }]),
    ]);
    const from = first[0]?.created_at;
    const to = last[0]?.created_at;
    if (!(from instanceof Date) || !(to instanceof Date)) {
      // Almost always means Extended JSON was imported with JSON.parse, leaving
      // `{$date: ...}` sub-documents. See HANDOFF.md, "Extended JSON on import".
      throw new Error("leads.created_at is not a BSON date - re-run scripts/import_data.mjs");
    }
    return (this.window = { from: fmtDay(from), to: fmtDay(to) });
  }

  async ask(question: string): Promise<AnalystAnswer> {
    const t0 = Date.now();
    const trimmed = question.trim();
    if (!trimmed) return { ok: false, kind: "error", question, message: "Ask a question first." };

    try {
      const llm = this.provider();
      const ctx = {
        today: new Date(),
        dataWindow: await this.dataWindow(),
        previousIntent: this.state.lastIntent,
      };

      const tPlan = Date.now();
      const plan = await llm.plan(trimmed, ctx);
      const planMs = Date.now() - tPlan;

      if (plan.kind === "refusal") {
        const message = refusalMessage(plan.reason, plan.suggestion);
        this.remember(trimmed, message, null);
        return {
          ok: false,
          kind: "refusal",
          question: trimmed,
          reason: plan.reason,
          suggestion: plan.suggestion,
          message,
        };
      }

      const result = await execute(this.data(), plan.intent);
      const chart = suggestChart(result);

      // Narration is the one step that can fail without costing the user the
      // answer, so a failure degrades to a computed summary instead of a 500.
      const tNarrate = Date.now();
      let headline = fallbackHeadline(result);
      let narrative = fallbackNarrative(result);
      let finalChart = chart;
      try {
        const narration = await llm.narrate(trimmed, result, chartTypeIsNegotiable(chart));
        headline = narration.headline;
        narrative = narration.narrative;
        finalChart = applyChartChoice(chart, narration.chartType);
      } catch {
        result.meta.notes.push("Narration was unavailable; this summary was generated from the numbers.");
      }
      const narrateMs = Date.now() - tNarrate;

      this.remember(trimmed, narrative, plan.intent);

      return {
        ok: true,
        question: trimmed,
        headline,
        narrative,
        chart: finalChart,
        table: toTable(result),
        intent: plan.intent,
        queries: result.meta.queries,
        notes: result.meta.notes,
        timings: { planMs, queryMs: result.meta.ms, narrateMs, totalMs: Date.now() - t0 },
      };
    } catch (e) {
      return { ok: false, kind: "error", question: trimmed, message: e instanceof Error ? e.message : String(e) };
    }
  }

  private remember(question: string, answer: string, intent: QueryIntent | null): void {
    const at = new Date().toISOString();
    const turn: AnalystState["messages"] = [
      { role: "user", text: question, at },
      { role: "assistant", text: answer, at },
    ];
    this.setState({
      messages: [...this.state.messages, ...turn].slice(-40),
      lastIntent: intent ?? this.state.lastIntent,
    });
  }

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "POST" && path.endsWith("/ask")) {
      const body = (await req.json().catch(() => ({}))) as { question?: string };
      const answer = await this.ask(body.question ?? "");
      return Response.json(answer, { status: answer.ok ? 200 : 400 });
    }

    if (path.endsWith("/reset")) {
      this.setState(INITIAL);
      return Response.json({ ok: true, reset: true });
    }

    if (path.endsWith("/spike")) {
      const t0 = Date.now();
      try {
        const rows = await this.data().aggregate("leads", [
          { $match: { lead_source: "Olark Chat" } },
          {
            $group: {
              _id: { $dateTrunc: { date: "$created_at", unit: "week" } },
              leads: { $sum: 1 },
              won: { $sum: { $cond: ["$converted", 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ]);
        return Response.json({ ok: true, ms: Date.now() - t0, buckets: rows.length });
      } catch (e) {
        return Response.json({ ok: false, ms: Date.now() - t0, error: String(e) }, { status: 500 });
      }
    }

    return Response.json({
      ok: true,
      agent: "AnalystAgent",
      db: this.env.MONGODB_DB_NAME,
      dataPath: this.env.DATA_PATH_MODE,
      llm: this.env.LLM_PROVIDER,
      turns: this.state.messages.length,
      lastIntent: this.state.lastIntent,
    });
  }
}

function toTable(result: ResultSet): AnswerTable {
  const columns: { key: string; label: string }[] = [];
  if (result.grain !== "total") columns.push({ key: "period", label: titleCase(result.grain) });
  for (const d of result.dimensions) columns.push({ key: d, label: titleCase(d) });
  columns.push({ key: "value", label: result.metric.label });
  if (result.comparisonRange) {
    columns.push({ key: "prior", label: "Prior" });
    columns.push({ key: "change", label: "Change" });
  }
  const supportKeys = [...new Set(result.rows.flatMap((r) => Object.keys(r.support)))];
  for (const k of supportKeys) columns.push({ key: k, label: titleCase(k) });

  const rows = result.rows.map((r) => {
    const row: Record<string, string> = {};
    if (r.period) row.period = r.period;
    for (const [k, v] of Object.entries(r.dims)) row[k] = v;
    row.value = r.formatted;
    if (r.comparison) {
      row.prior = r.comparison.formatted;
      row.change = r.comparison.ratio === null ? "n/a" : `${(r.comparison.ratio * 100 - 100).toFixed(0)}%`;
    }
    for (const k of supportKeys) {
      const v = r.support[k];
      row[k] = v === null || v === undefined ? "" : formatSupport(k, v);
    }
    return row;
  });

  return { columns, rows };
}

function formatSupport(key: string, v: number): string {
  return key === "spend" ? formatValue(v, "currency_inr") : Math.round(v).toLocaleString("en-IN");
}

function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Deterministic stand-ins, used when the narration call fails. */
function fallbackHeadline(result: ResultSet): string {
  const total = result.total?.formatted ?? "n/a";
  return `${result.metric.label}: ${total} (${result.range.from} to ${result.range.to})`;
}

function fallbackNarrative(result: ResultSet): string {
  const parts: string[] = [];
  const total = result.total;
  if (total) {
    parts.push(`${result.metric.label} across the window was ${total.formatted}.`);
    if (total.comparison?.ratio != null) {
      const pct = total.comparison.ratio * 100 - 100;
      parts.push(`That is ${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(0)}% on the comparison window.`);
    }
  }
  const best = topRow(result.rows);
  if (best && result.dimensions.length > 0) {
    const label = result.dimensions.map((d) => best.dims[d]).join(" / ");
    parts.push(`Highest: ${label} at ${best.formatted}.`);
  }
  return parts.join(" ") || "No rows matched this query.";
}

function topRow(rows: ResultRow[]): ResultRow | null {
  let best: ResultRow | null = null;
  for (const r of rows) {
    if (r.value === null) continue;
    if (!best || best.value === null || r.value > best.value) best = r;
  }
  return best;
}
