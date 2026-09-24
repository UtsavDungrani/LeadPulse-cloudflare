/**
 * The weekly digest: assembled deterministically, summarised by the model.
 *
 * ## Two blocks, because two different things are knowable
 * A digest that reports "conversion rate last week" is wrong, and confidently
 * so - conversion lag runs from days to two months depending on the channel, so
 * last week's cohort has barely started converting. Reporting it produces a
 * number that always looks like a collapse and always recovers, and a reader
 * who learns to ignore it.
 *
 * So the digest separates what is knowable now from what is knowable yet:
 *
 *  - **This period** - volume, cost per lead, SLA. Facts about the week itself.
 *  - **Matured cohort** - conversion and CAC, for a window that ended
 *    `MATURATION_DAYS` ago and has therefore had time to resolve.
 *
 * Both blocks say which window they cover. That is the whole trick.
 */
import type { DataSource } from "../db/types";
import { execute } from "../semantic/execute";
import { validateIntent } from "../semantic/intent";
import { MATURATION_DAYS, METRICS, type MetricId } from "../semantic/metrics";
import { previousPeriod, shiftDays, type DateRange } from "../semantic/dates";

export interface DigestMetric {
  id: string;
  label: string;
  formatted: string;
  priorFormatted: string;
  /** Percentage change against the prior window; null when either side is n/a. */
  changePct: number | null;
  higherIsBetter: boolean;
}

export interface DigestChannel {
  name: string;
  leads: number;
  share: number;
  changePct: number | null;
}

export interface DigestFinding {
  key: string;
  kind: string;
  status: string;
  headline: string;
  impact: string;
  narrative?: string;
}

export interface Digest {
  generatedAt: string;
  period: DateRange;
  priorPeriod: DateRange;
  /** The lagged window the outcome metrics describe. */
  maturedPeriod: DateRange;
  thisPeriod: DigestMetric[];
  maturedCohort: DigestMetric[];
  channels: DigestChannel[];
  findings: DigestFinding[];
  /**
   * When the Watchtower last swept. The digest reports what the detector
   * currently holds rather than re-detecting, so a reader needs to know how old
   * that is - findings from a scan three weeks ago are not this week's news.
   */
  findingsAsOf: string | null;
  /** Model-written when available, deterministic otherwise. */
  summary: string;
  summarySource: "model" | "computed";
  markdown: string;
}

/** Metrics measurable about the period itself. */
const LIVE_METRICS: MetricId[] = ["leads_created", "cpl", "sla_breach_rate"];
/** Metrics that need the cohort to have had time to resolve. */
const MATURED_METRICS: MetricId[] = ["conversion_rate_21d", "cac", "avg_days_to_convert"];

export interface DigestOptions {
  /** End of the reporting period, inclusive. Defaults to yesterday. */
  asOf?: Date;
  /** Length of the reporting period in days. */
  periodDays?: number;
  findings?: DigestFinding[];
  findingsAsOf?: string | null;
}

export async function buildDigest(ds: DataSource, opts: DigestOptions = {}): Promise<Digest> {
  const asOf = opts.asOf ?? new Date();
  const periodDays = opts.periodDays ?? 7;

  const to = shiftDays(toDay(asOf), -1);
  const period: DateRange = { from: shiftDays(to, -(periodDays - 1)), to };
  const maturedTo = shiftDays(to, -MATURATION_DAYS);
  const maturedPeriod: DateRange = { from: shiftDays(maturedTo, -(periodDays - 1)), to: maturedTo };

  const [thisPeriod, maturedCohort, channels] = await Promise.all([
    metricBlock(ds, LIVE_METRICS, period),
    metricBlock(ds, MATURED_METRICS, maturedPeriod),
    channelBlock(ds, period),
  ]);

  const findings = opts.findings ?? [];
  const digest: Digest = {
    generatedAt: new Date().toISOString(),
    period,
    priorPeriod: previousPeriod(period),
    maturedPeriod,
    thisPeriod,
    maturedCohort,
    channels,
    findings,
    findingsAsOf: opts.findingsAsOf ?? null,
    summary: computedSummary(thisPeriod, maturedCohort, findings),
    summarySource: "computed",
    markdown: "",
  };
  digest.markdown = renderMarkdown(digest);
  return digest;
}

function toDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function metricBlock(
  ds: DataSource,
  ids: MetricId[],
  range: DateRange,
): Promise<DigestMetric[]> {
  const out: DigestMetric[] = [];
  for (const id of ids) {
    const def = METRICS[id];
    const result = await execute(
      ds,
      validateIntent({
        metric: id,
        grain: "total",
        dateRange: range,
        dimensions: [],
        filters: [],
        compareTo: "previous_period",
        limit: 1,
      }),
    );
    const total = result.total;
    const ratio = total?.comparison?.ratio ?? null;
    out.push({
      id,
      label: def.label,
      formatted: total?.formatted ?? "n/a",
      priorFormatted: total?.comparison?.formatted ?? "n/a",
      changePct: ratio === null ? null : ratio * 100 - 100,
      higherIsBetter: def.higherIsBetter,
    });
  }
  return out;
}

async function channelBlock(ds: DataSource, range: DateRange): Promise<DigestChannel[]> {
  const result = await execute(
    ds,
    validateIntent({
      metric: "leads_created",
      grain: "total",
      dateRange: range,
      dimensions: ["lead_source"],
      filters: [],
      compareTo: "previous_period",
      limit: 6,
    }),
  );
  const total = result.rows.reduce((a, r) => a + (r.value ?? 0), 0);
  return result.rows.map((r) => ({
    name: r.dims.lead_source ?? "(unknown)",
    leads: r.value ?? 0,
    share: total > 0 ? (r.value ?? 0) / total : 0,
    changePct: r.comparison?.ratio == null ? null : r.comparison.ratio * 100 - 100,
  }));
}

/**
 * The summary written without a model.
 *
 * Always produced, and used verbatim when the narration call is unavailable or
 * fails. A digest that does not arrive because a model was down would be a poor
 * trade for some nicer prose.
 */
function computedSummary(
  live: DigestMetric[],
  matured: DigestMetric[],
  findings: DigestFinding[],
): string {
  const parts: string[] = [];
  const leads = live.find((m) => m.id === "leads_created");
  if (leads) {
    parts.push(
      leads.changePct === null
        ? `${leads.formatted} leads this period.`
        : `${leads.formatted} leads this period, ${direction(leads.changePct)} on the week before.`,
    );
  }
  const conv = matured.find((m) => m.id === "conversion_rate_21d");
  if (conv) {
    parts.push(
      `The cohort that has had time to convert is running at ${conv.formatted}${
        conv.changePct === null ? "" : `, ${direction(conv.changePct)}`
      }.`,
    );
  }
  const open = findings.filter((f) => f.kind === "incident" && f.status !== "resolved");
  parts.push(
    open.length === 0
      ? "The watchtower has nothing open."
      : `${open.length} open finding${open.length === 1 ? "" : "s"}, the largest being: ${open[0]!.headline}.`,
  );
  return parts.join(" ");
}

function direction(pct: number): string {
  const word = pct >= 0 ? "up" : "down";
  return `${word} ${Math.abs(pct).toFixed(0)}%`;
}

/**
 * The change cell, phrased by whether the move is *good* rather than by which
 * way it went. SLA breaches falling is an improvement; making a reader hold the
 * polarity of every metric in their head is how a digest gets skimmed.
 */
function mood(m: DigestMetric): string {
  if (m.changePct === null) return "—";
  if (Math.abs(m.changePct) < 1) return "flat";
  const good = m.changePct > 0 === m.higherIsBetter;
  return `${direction(m.changePct)}${good ? "" : " — worse"}`;
}

export function renderMarkdown(d: Digest): string {
  const rows = (ms: DigestMetric[]) =>
    ms.map((m) => `| ${m.label} | ${m.formatted} | ${m.priorFormatted} | ${mood(m)} |`).join("\n");

  const lines = [
    `# Pipeline digest — ${d.period.from} to ${d.period.to}`,
    "",
    d.summary,
    "",
    "## This period",
    "",
    "| Metric | Now | Prior | Change |",
    "|---|---|---|---|",
    rows(d.thisPeriod),
    "",
    `## Matured cohort (${d.maturedPeriod.from} to ${d.maturedPeriod.to})`,
    "",
    `Leads created in this earlier window, which has had ${MATURATION_DAYS} days to convert.`,
    "",
    "| Metric | Now | Prior | Change |",
    "|---|---|---|---|",
    rows(d.maturedCohort),
    "",
    "## Channels",
    "",
    "| Source | Leads | Share | Change |",
    "|---|---|---|---|",
    d.channels
      .map(
        (c) =>
          `| ${c.name} | ${c.leads} | ${(c.share * 100).toFixed(0)}% | ${
            c.changePct === null ? "—" : direction(c.changePct)
          } |`,
      )
      .join("\n"),
    "",
    "## Watchtower",
    "",
    d.findingsAsOf ? `_Last swept ${d.findingsAsOf.slice(0, 16).replace("T", " ")} UTC._` : "_Never swept._",
    "",
    d.findings.length === 0
      ? "Nothing open."
      : d.findings
          .map((f) => `- **${f.headline}** (${f.kind}, ${f.status})\n  ${f.narrative ?? f.impact}`)
          .join("\n"),
  ];
  return lines.join("\n");
}
