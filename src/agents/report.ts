/**
 * `ReportAgent` - the scheduled digest.
 *
 * The Watchtower answers "did something break?"; this answers "how are we
 * doing?", on a cadence, without anyone asking. It reads from the same semantic
 * layer as the Analyst and pulls the current findings from the Watchtower, so
 * the digest and the alert feed can never disagree about a number.
 *
 * Delivery is off by default - see `report/deliver.ts`. A digest is generated,
 * stored and readable; sending it anywhere is a deliberate configuration step.
 */
import { Agent, getAgentByName } from "agents";
import { createDriverDataSource } from "../db/driver";
import { readOnly } from "../db/readonly";
import type { DataSource } from "../db/types";
import { buildDigest, renderMarkdown, type Digest, type DigestFinding } from "../report/digest";
import { deliver, resolveSink, type DeliveryResult } from "../report/deliver";
import { createProvider, type LLMProvider } from "../llm";
import type { Env } from "./analyst";

export interface ReportState {
  latest: Digest | null;
  lastDelivery: DeliveryResult | null;
  history: { at: string; period: string; findings: number; delivered: boolean; ms: number }[];
  schedule: string | null;
}

const INITIAL: ReportState = { latest: null, lastDelivery: null, history: [], schedule: null };

/**
 * Monday 08:00 UTC. A weekly digest wants to land before the week is planned,
 * not after; and weekly rather than daily because a seven-day period is the
 * shortest window in which this pipeline's numbers are not mostly noise.
 */
const DEFAULT_CRON = "0 8 * * 1";
const PERIOD_DAYS = 7;

export class ReportAgent extends Agent<Env, ReportState> {
  initialState = INITIAL;

  private ds: DataSource | null = null;
  private llm: LLMProvider | null = null;

  /** Read-only: the digest reports, it never changes anything. */
  private data(): DataSource {
    return (this.ds ??= readOnly(
      createDriverDataSource(this.env.MONGODB_URI, this.env.MONGODB_DB_NAME),
    ));
  }

  async onStart(): Promise<void> {
    const cron = this.env.REPORT_CRON || DEFAULT_CRON;
    await this.schedule(cron, "runReport", { reason: "scheduled" });
    if (this.state.schedule !== cron) this.setState({ ...this.state, schedule: cron });
  }

  /**
   * Findings from the Watchtower, rather than a second detector.
   *
   * Two components computing "what is wrong" independently is how a digest
   * ends up contradicting the alert someone already acted on.
   */
  private async findings(): Promise<{ findings: DigestFinding[]; asOf: string | null }> {
    try {
      const watchtower = await getAgentByName(this.env.WatchtowerAgent, "default");
      const response = await watchtower.fetch(new Request("https://agent/"));
      if (!response.ok) return { findings: [], asOf: null };
      const body = (await response.json()) as {
        lastScanAt?: string | null;
        findings?: { key: string; kind: string; status: string; headline: string; impact: string; narrative?: string }[];
      };
      return {
        asOf: body.lastScanAt ?? null,
        findings: (body.findings ?? [])
          .filter((f) => f.status !== "resolved")
          .map((f) => ({
            key: f.key,
            kind: f.kind,
            status: f.status,
            headline: f.headline,
            impact: f.impact,
            narrative: f.narrative,
          })),
      };
    } catch {
      // A digest without the findings block is still a useful digest.
      return { findings: [], asOf: null };
    }
  }

  async runReport(payload?: { asOf?: string }): Promise<{ digest: Digest; delivery: DeliveryResult }> {
    const t0 = Date.now();
    const watch = await this.findings();
    const digest = await buildDigest(this.data(), {
      asOf: payload?.asOf ? new Date(payload.asOf) : new Date(),
      periodDays: PERIOD_DAYS,
      findings: watch.findings,
      findingsAsOf: watch.asOf,
    });

    // The model writes the opening paragraph over numbers that are already
    // final. If it cannot, the computed summary that is already in place stands.
    try {
      const llm = (this.llm ??= createProvider(this.env));
      const written = await llm.summariseDigest(brief(digest));
      if (usable(written)) {
        digest.summary = written;
        digest.summarySource = "model";
      }
    } catch {
      digest.summarySource = "computed";
    }
    digest.markdown = renderMarkdown(digest);

    const delivery = await deliver(digest, this.env);
    const ms = Date.now() - t0;

    this.setState({
      ...this.state,
      latest: digest,
      lastDelivery: delivery,
      history: [
        {
          at: digest.generatedAt,
          period: `${digest.period.from}..${digest.period.to}`,
          findings: digest.findings.length,
          delivered: delivery.delivered,
          ms,
        },
        ...this.state.history,
      ].slice(0, 20),
    });

    return { digest, delivery };
  }

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "POST" && path.endsWith("/run")) {
      const body = (await req.json().catch(() => ({}))) as { asOf?: string };
      const { digest, delivery } = await this.runReport({ asOf: body.asOf });
      return Response.json({ ok: true, digest, delivery });
    }

    if (path.endsWith("/latest.md")) {
      const md = this.state.latest?.markdown ?? "No digest has been generated yet.";
      return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }

    if (path.endsWith("/latest")) {
      return Response.json({ ok: true, digest: this.state.latest, delivery: this.state.lastDelivery });
    }

    return Response.json({
      ok: true,
      agent: "ReportAgent",
      schedule: this.state.schedule ?? this.env.REPORT_CRON ?? DEFAULT_CRON,
      sink: resolveSink(this.env),
      lastRunAt: this.state.latest?.generatedAt ?? null,
      lastDelivery: this.state.lastDelivery,
      history: this.state.history,
    });
  }
}

/**
 * A summary that cites no figure at all is not a summary.
 *
 * The weaker fallback model sometimes returns something like "the following is
 * generated text based on the given data". That is worse than the computed
 * paragraph it would replace, and cheap to catch: a real summary of this digest
 * quotes at least one number.
 */
function usable(summary: string): boolean {
  return summary.trim().length >= 60 && /\d/.test(summary);
}

/** The numbers handed to the model. Compact, final, and nothing else. */
function brief(d: Digest): string {
  const block = (title: string, ms: Digest["thisPeriod"]) =>
    `${title}\n${ms.map((m) => `- ${m.label}: ${m.formatted} (prior ${m.priorFormatted}${m.changePct === null ? "" : `, ${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(0)}%`}; ${m.higherIsBetter ? "higher is better" : "lower is better"})`).join("\n")}`;

  return [
    `Reporting period: ${d.period.from} to ${d.period.to} (prior ${d.priorPeriod.from} to ${d.priorPeriod.to}).`,
    block("This period:", d.thisPeriod),
    block(`Matured cohort, created ${d.maturedPeriod.from} to ${d.maturedPeriod.to}:`, d.maturedCohort),
    `Channels: ${d.channels.map((c) => `${c.name} ${c.leads} leads (${(c.share * 100).toFixed(0)}%)`).join("; ")}`,
    d.findings.length === 0
      ? "Watchtower: nothing open."
      : `Watchtower, open findings:\n${d.findings.map((f) => `- ${f.headline} — ${f.impact}`).join("\n")}`,
  ].join("\n\n");
}
