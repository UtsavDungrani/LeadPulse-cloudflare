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
import { readOnly } from "../db/readonly";
import type { DataSource } from "../db/types";
import type { OverviewIntent, QueryIntent } from "../semantic/intent";
import { overviewSummary, runOverview, type OverviewResult } from "../semantic/overview";
import { execute, type ResultSet, type ResultRow } from "../semantic/execute";
import {
  applyChartChoice,
  compatibleCharts,
  suggestChart,
  type ChartSpec,
  type ChartType,
} from "../semantic/chart";
import { formatValue } from "../semantic/metrics";
import { fmtDay, type DateRange } from "../semantic/dates";
import {
  checkFigures,
  createProvider,
  narrationUserPrompt,
  overviewBrief,
  refusalMessage,
  usableProse,
  type LLMProvider,
} from "../llm";

export interface Env {
  AnalystAgent: DurableObjectNamespace<AnalystAgent>;
  WatchtowerAgent: DurableObjectNamespace<import("./watchtower").WatchtowerAgent>;
  ReportAgent: DurableObjectNamespace<import("./report").ReportAgent>;
  LeadDeskAgent: DurableObjectNamespace<import("./leaddesk").LeadDeskAgent>;
  SessionsAgent: DurableObjectNamespace<import("./sessions").SessionsAgent>;
  AI: Ai;
  MONGODB_URI: string;
  MONGODB_DB_NAME: string;
  DATA_PATH_MODE: "bridge" | "driver";
  BRIDGE_URL: string;
  LLM_PROVIDER?: string;
  /** Cron for the Watchtower sweep. Empty falls back to the daily default. */
  WATCH_CRON?: string;
  /** Cron for the weekly digest. Empty falls back to Monday morning. */
  REPORT_CRON?: string;
  /** "none" (default) or "webhook". Delivery is off unless set deliberately. */
  REPORT_SINK?: string;
  /** Secret. Only read when REPORT_SINK is "webhook". */
  REPORT_WEBHOOK_URL?: string;
}

/**
 * One question and the whole answer to it.
 *
 * The full answer is kept, not a summary of it, because reopening a session has
 * to redraw the chart, the table and the audit trail. Keeping only the prose
 * would mean either re-running the query - charging the user twice for the same
 * answer, against data that may have moved - or showing a transcript whose
 * numbers cannot be checked.
 */
export interface AnalystTurn {
  id: string;
  at: string;
  question: string;
  answer: AnalystAnswer;
}

export interface AnalystState {
  /** Conversation so far, as plain text. Cheap to scan, cheap to keep. */
  messages: { role: "user" | "assistant"; text: string; at: string }[];
  /** The rendered transcript: bounded, because each turn carries its points. */
  turns: AnalystTurn[];
  /**
   * The last `QueryIntent` this session compiled. Follow-ups like "now break
   * that by city" clone this and patch one field.
   */
  lastIntent: QueryIntent | null;
}

/**
 * How many answers a session redraws. Each turn carries its own points, so this
 * is a memory bound, not a preference - twenty answers of a few hundred rows is
 * comfortable inside a Durable Object, two hundred is not.
 */
const MAX_TURNS = 20;

export interface AnswerTable {
  columns: { key: string; label: string }[];
  rows: Record<string, string>[];
}

/**
 * The numeric series behind the chart.
 *
 * Separate from `table`, which is formatted for reading. A renderer needs the
 * numbers; a reader needs "22.2%". Shipping only the table would force the UI to
 * parse its own display strings back into floats, which is exactly the kind of
 * round-trip that puts a wrong number on a screen.
 */
export interface AnswerPoint {
  period: string | null;
  dims: Record<string, string>;
  value: number | null;
  formatted: string;
  comparison: number | null;
}

export type AnalystAnswer =
  | {
      ok: true;
      /**
       * Optional because answers stored before the overview existed do not
       * carry it. Absent means the ordinary single-metric answer.
       */
      kind?: "answer";
      question: string;
      headline: string;
      narrative: string;
      chart: ChartSpec;
      table: AnswerTable;
      points: AnswerPoint[];
      /** The audit trail: what was asked of the database, and why. */
      intent: QueryIntent;
      queries: ResultSet["meta"]["queries"];
      notes: string[];
      timings: { planMs: number; queryMs: number; narrateMs: number; totalMs: number };
    }
  | {
      /**
       * The answer to a question that named no metric. Several numbers over one
       * window rather than one number in detail - no chart, because seven
       * unrelated measures on one axis is the dual-axis mistake with five more
       * axes.
       */
      ok: true;
      kind: "overview";
      question: string;
      headline: string;
      narrative: string;
      overview: OverviewResult;
      /** Whether the prose above was written by the model or computed. */
      summarySource: "model" | "computed";
      intent: OverviewIntent;
      queries: ResultSet["meta"]["queries"];
      notes: string[];
      timings: { planMs: number; queryMs: number; narrateMs: number; totalMs: number };
    }
  | { ok: false; kind: "refusal"; question: string; reason: string; suggestion: string; message: string }
  | { ok: false; kind: "error"; question: string; message: string };

const INITIAL: AnalystState = { messages: [], turns: [], lastIntent: null };

export class AnalystAgent extends Agent<Env, AnalystState> {
  initialState = INITIAL;

  private ds: DataSource | null = null;
  private llm: LLMProvider | null = null;
  private window: DateRange | null = null;

  /** Read-only: the Analyst answers questions, it never changes anything. */
  private data(): DataSource {
    return (this.ds ??= readOnly(
      createDriverDataSource(this.env.MONGODB_URI, this.env.MONGODB_DB_NAME),
    ));
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
        const refusal: AnalystAnswer = {
          ok: false,
          kind: "refusal",
          question: trimmed,
          reason: plan.reason,
          suggestion: plan.suggestion,
          message,
        };
        // A refusal is part of the transcript. Dropping it would leave a
        // session where a question was asked and nothing came back.
        this.remember(trimmed, message, null, refusal);
        return refusal;
      }

      if (plan.kind === "overview") {
        return await this.answerOverview(trimmed, plan.overview, ctx.dataWindow, planMs, t0);
      }

      const result = await execute(this.data(), plan.intent);
      const chart = suggestChart(result);
      const points = toPoints(result);
      /*
       * One rule set decides which forms this result can carry. It bounds what
       * the narrator may choose here, and the browser runs the same function on
       * the same points to build the picker - rather than being handed a list,
       * which would freeze an answer under the rules that existed when it was
       * written.
       */
      const allowedCharts = compatibleCharts(chart, points);

      // Narration is the one step that can fail without costing the user the
      // answer, so a failure degrades to a computed summary instead of a 500.
      const tNarrate = Date.now();
      let headline = fallbackHeadline(result);
      let narrative = fallbackNarrative(result);
      let finalChart = chart;
      try {
        const narration = await llm.narrate(trimmed, result, allowedCharts);
        // The chart choice is safe whatever the prose does - it is checked
        // against the compatible list, not against the sentence.
        finalChart = applyChartChoice(chart, narration.chartType, allowedCharts);

        // Same rule as the overview: the model may write the sentence, but
        // every figure in it has to have come from the table it was given. An
        // invented number in a true-sounding sentence is the one error a
        // reader has no way to catch.
        const written = `${narration.headline} ${narration.narrative}`;
        const figures = checkFigures(written, narrationUserPrompt(trimmed, result));
        if (figures.ok) {
          headline = narration.headline;
          narrative = narration.narrative;
        } else {
          result.meta.notes.push(
            `The written summary was discarded: it contained ${figures.invented.length === 1 ? "a figure" : "figures"} ` +
              `not in the result (${figures.invented.join(", ")}). This summary was generated from the numbers.`,
          );
        }
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        result.meta.notes.push(`Narration was unavailable (${why}); this summary was generated from the numbers.`);
      }
      const narrateMs = Date.now() - tNarrate;

      const answer: AnalystAnswer = {
        ok: true,
        question: trimmed,
        headline,
        narrative,
        chart: finalChart,
        table: toTable(result),
        points,
        intent: plan.intent,
        queries: result.meta.queries,
        notes: result.meta.notes,
        timings: { planMs, queryMs: result.meta.ms, narrateMs, totalMs: Date.now() - t0 },
      };

      this.remember(trimmed, narrative, plan.intent, answer);
      return answer;
    } catch (e) {
      return { ok: false, kind: "error", question: trimmed, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * The overview answer.
   *
   * The read-out is written by the model, over numbers it is handed and cannot
   * recompute - and then checked: every figure in the prose must appear in the
   * brief, or the whole thing is discarded for the computed summary. Wanting
   * prose from a model and wanting the numbers in it to be true are only
   * compatible because of that check.
   *
   * `lastIntent` is deliberately not touched - there is no single metric here
   * for a follow-up like "now break that down by city" to patch, and leaving
   * the previous one in place keeps that follow-up working.
   */
  private async answerOverview(
    question: string,
    overview: OverviewIntent,
    dataWindow: DateRange,
    planMs: number,
    t0: number,
  ): Promise<AnalystAnswer> {
    const result = await runOverview(this.data(), overview, dataWindow.to);

    const computed = overviewSummary(result);
    let { headline, narrative } = computed;
    let summarySource: "model" | "computed" = "computed";

    const tNarrate = Date.now();
    const brief = overviewBrief(question, result);
    try {
      const written = await this.provider().narrateOverview(question, brief);
      const figures = checkFigures(`${written.headline} ${written.narrative}`, brief);
      if (!figures.ok) {
        // A figure that was not in the brief was invented, which is the one
        // failure a reader cannot catch. The computed summary stands.
        result.notes.push(
          `The written summary was discarded: it contained ${figures.invented.length === 1 ? "a figure" : "figures"} ` +
            `not in the data (${figures.invented.join(", ")}). This summary was computed from the numbers.`,
        );
      } else if (!usableProse(written.narrative)) {
        result.notes.push("The written summary was too thin to use; this one was computed from the numbers.");
      } else {
        headline = written.headline || headline;
        narrative = written.narrative;
        summarySource = "model";
      }
    } catch (e) {
      // The reason matters: a malformed response and a model that refused are
      // different problems, and a note that hides which is a note that costs a
      // debugging session.
      const why = e instanceof Error ? e.message : String(e);
      result.notes.push(`The summary could not be written (${why}); this one was computed from the numbers.`);
    }
    const narrateMs = Date.now() - tNarrate;

    const answer: AnalystAnswer = {
      ok: true,
      kind: "overview",
      question,
      headline,
      narrative,
      overview: result,
      summarySource,
      intent: overview,
      queries: result.queries,
      notes: result.notes,
      timings: { planMs, queryMs: result.ms, narrateMs, totalMs: Date.now() - t0 },
    };

    this.remember(question, narrative, null, answer);
    return answer;
  }

  private remember(
    question: string,
    text: string,
    intent: QueryIntent | null,
    answer: AnalystAnswer,
  ): void {
    const at = new Date().toISOString();
    const messages: AnalystState["messages"] = [
      { role: "user", text: question, at },
      { role: "assistant", text, at },
    ];
    // A session persisted before `turns` existed has no `turns` key, and the
    // spread of an undefined throws. Defaulting here is cheaper than a migration.
    const turns = this.state.turns ?? [];
    this.setState({
      messages: [...this.state.messages, ...messages].slice(-40),
      turns: [...turns, { id: `${Date.now().toString(36)}-${turns.length}`, at, question, answer }].slice(-MAX_TURNS),
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

    if (path.endsWith("/history")) {
      return Response.json({ turns: this.state.turns ?? [], lastIntent: this.state.lastIntent });
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
      // The provider that answers.
      llm: this.provider().name,
      llmRequested: this.env.LLM_PROVIDER ?? "workers-ai",
      turns: this.state.messages.length,
      lastIntent: this.state.lastIntent,
    });
  }
}

function toPoints(result: ResultSet): AnswerPoint[] {
  return result.rows.map((r) => ({
    period: r.period,
    dims: r.dims,
    value: r.value,
    formatted: r.formatted,
    comparison: r.comparison?.value ?? null,
  }));
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
