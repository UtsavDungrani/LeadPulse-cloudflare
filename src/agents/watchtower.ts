/**
 * `WatchtowerAgent` - the proactive half of the copilot.
 *
 * This is the part that justifies the Agents SDK. The Analyst is a request in,
 * an answer out; a stateless Worker would do. The Watchtower wakes up on its
 * own, sweeps the pipeline, remembers what it has already told you, and only
 * speaks when something is new. Every one of those verbs needs durable state
 * and a scheduler, which is what a Durable Object is.
 *
 * The detection is entirely deterministic - statistics in `watch/`, no model.
 * The model is used for exactly one thing: writing a sentence about a finding
 * that has already been found. If it is unavailable the alert still arrives,
 * carrying the deterministic headline.
 */
import { Agent } from "agents";
import { createDriverDataSource } from "../db/driver";
import { readOnly } from "../db/readonly";
import type { DataSource } from "../db/types";
import { scan, type ScanReport } from "../watch/scan";
import { mergeFindings, type Finding, type TrackedFinding } from "../watch/findings";
import { fmtDay } from "../semantic/dates";
import { createProvider, type LLMProvider } from "../llm";
import type { Env } from "./analyst";

export interface WatchtowerState {
  /** Everything currently on the board, ranked by impact. */
  findings: TrackedFinding[];
  lastScanAt: string | null;
  lastScanMs: number | null;
  /** Rolling log, newest first, so a reader can see the cadence. */
  history: { at: string; incidents: number; marketShifts: number; raised: number; ms: number }[];
  /** Cron expression currently installed. */
  schedule: string | null;
}

const INITIAL: WatchtowerState = {
  findings: [],
  lastScanAt: null,
  lastScanMs: null,
  history: [],
  schedule: null,
};

/**
 * 07:00 UTC daily. Early enough that a fault from yesterday is on someone's
 * screen before the day starts, and daily rather than hourly because the
 * windows are measured in days - scanning every hour would re-test the same
 * data and spend the multiple-comparison budget for nothing.
 */
const DEFAULT_CRON = "0 7 * * *";

/** Narrate at most this many new findings per scan. */
const NARRATE_LIMIT = 3;

export class WatchtowerAgent extends Agent<Env, WatchtowerState> {
  initialState = INITIAL;

  private ds: DataSource | null = null;
  private llm: LLMProvider | null = null;
  private start: string | null = null;

  /** Read-only: the Watchtower observes, it never changes anything. */
  private data(): DataSource {
    return (this.ds ??= readOnly(
      createDriverDataSource(this.env.MONGODB_URI, this.env.MONGODB_DB_NAME),
    ));
  }

  /** `onStart` runs on every wake; `schedule` with a cron is idempotent. */
  async onStart(): Promise<void> {
    const cron = this.env.WATCH_CRON || DEFAULT_CRON;
    await this.schedule(cron, "runScan", { reason: "scheduled" });
    if (this.state.schedule !== cron) this.setState({ ...this.state, schedule: cron });
  }

  /** Earliest date with data, so a baseline never runs off the start. */
  private async dataStart(): Promise<string> {
    if (this.start) return this.start;
    const rows = await this.data().aggregate("leads", [
      { $sort: { created_at: 1 } },
      { $limit: 1 },
      { $project: { created_at: 1 } },
    ]);
    const first = rows[0]?.created_at;
    if (!(first instanceof Date)) {
      throw new Error("leads.created_at is not a BSON date - re-run scripts/import_data.mjs");
    }
    return (this.start = fmtDay(first));
  }

  /**
   * The scheduled callback. Sweeps, folds the result into what is already
   * known, and narrates only what is genuinely new.
   */
  async runScan(payload?: { reason?: string; asOf?: string }): Promise<ScanReport> {
    const report = await scan(this.data(), {
      asOf: payload?.asOf ? new Date(payload.asOf) : new Date(),
      dataStart: await this.dataStart(),
    });

    const now = new Date().toISOString();
    const { tracked, newlyRaised } = mergeFindings(this.state.findings, report.findings, now);
    await this.narrate(newlyRaised);

    const incidents = report.findings.filter((f) => f.kind === "incident").length;
    this.setState({
      ...this.state,
      findings: tracked,
      lastScanAt: now,
      lastScanMs: report.ms,
      history: [
        {
          at: now,
          incidents,
          marketShifts: report.findings.length - incidents,
          raised: newlyRaised.length,
          ms: report.ms,
        },
        ...this.state.history,
      ].slice(0, 30),
    });

    return report;
  }

  /**
   * Prose for newly raised findings, highest impact first.
   *
   * Capped, and only for findings that are actually new: re-narrating an
   * ongoing finding on every scan spends tokens to repeat yesterday's sentence.
   * Failure is swallowed - the deterministic headline and impact line are
   * already on the finding, and an alert without prose is far better than no
   * alert.
   */
  private async narrate(fresh: TrackedFinding[]): Promise<void> {
    if (fresh.length === 0) return;
    let llm: LLMProvider;
    try {
      llm = this.llm ??= createProvider(this.env);
    } catch {
      return;
    }

    for (const finding of fresh.slice(0, NARRATE_LIMIT)) {
      try {
        finding.narrative = await this.narrateOne(llm, finding);
      } catch {
        return; // If one call fails the next will too; do not burn the rest.
      }
    }
  }

  private async narrateOne(llm: LLMProvider, f: TrackedFinding): Promise<string> {
    return llm.narrateFinding({
      headline: f.headline,
      impact: f.impact,
      detector: f.detector,
      segment: f.member ?? "the whole pipeline",
      direction: f.direction,
      kind: f.kind,
      observed: f.observed,
      expected: f.expected,
      window: f.window,
      baseline: f.baseline,
      marketFactor: f.marketFactor,
    });
  }

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "POST" && path.endsWith("/scan")) {
      const body = (await req.json().catch(() => ({}))) as { asOf?: string };
      const report = await this.runScan({ reason: "manual", asOf: body.asOf });
      return Response.json({
        ok: true,
        asOf: report.asOf,
        findings: this.state.findings,
        stats: report.stats,
        ms: report.ms,
      });
    }

    if (req.method === "POST" && path.endsWith("/acknowledge")) {
      const body = (await req.json().catch(() => ({}))) as { key?: string };
      const at = new Date().toISOString();
      const findings = this.state.findings.map((f) =>
        f.key === body.key ? { ...f, acknowledgedAt: at } : f,
      );
      this.setState({ ...this.state, findings });
      return Response.json({ ok: true, acknowledged: body.key });
    }

    if (path.endsWith("/reset")) {
      this.setState(INITIAL);
      return Response.json({ ok: true, reset: true });
    }

    const incidents = this.state.findings.filter((f) => f.kind === "incident");
    return Response.json({
      ok: true,
      agent: "WatchtowerAgent",
      schedule: this.state.schedule ?? this.env.WATCH_CRON ?? DEFAULT_CRON,
      lastScanAt: this.state.lastScanAt,
      lastScanMs: this.state.lastScanMs,
      open: incidents.filter((f) => f.status !== "resolved").length,
      findings: this.state.findings,
      history: this.state.history,
    });
  }
}

export type { Finding, TrackedFinding };
