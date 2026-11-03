/**
 * The overview: what to answer when the question names no single metric.
 *
 * "How did yesterday go" is a real question, and the honest answers to it were
 * previously both wrong. Picking one of ten metrics and presenting it as the
 * answer is the worse one - it answers a narrower question than the one asked
 * and does not say so. Refusing is the better one, and still a dead end.
 *
 * So this runs the headline metrics over one window, deterministically, through
 * the same compiler every other answer goes through. There is no new query
 * path here and no new arithmetic: each tile is an ordinary `QueryIntent` that
 * a reader can find in the audit trail.
 *
 * ## The maturation split is the whole point
 * Reporting conversion or CAC for yesterday is confidently wrong - conversion
 * lag runs from days to two months by channel, so yesterday's cohort has barely
 * started converting and its rate always looks like a collapse that always
 * recovers. The outcome metrics are therefore reported for a window of the same
 * length that has had time to resolve, and the tile says which window that was.
 * This is the same rule the weekly digest follows, for the same reason.
 */
import type { DataSource } from "../db/types";
import { execute } from "../semantic/execute";
import { IntentError, validateIntent, type Filter, type OverviewIntent } from "./intent";
import { MATURATION_DAYS, METRICS, type MetricId } from "./metrics";
import { rangeDays, shiftDays, type DateRange } from "./dates";
import type { ResultSet } from "./execute";

/** Facts about the window itself. Knowable the moment the window closes. */
export const OVERVIEW_LIVE: MetricId[] = ["leads_created", "cpl", "sla_breach_rate", "open_pipeline"];

/** Outcomes. Knowable only once the cohort has had time to resolve. */
export const OVERVIEW_MATURED: MetricId[] = ["conversion_rate_21d", "cac", "avg_days_to_convert"];

export interface OverviewTile {
  id: MetricId;
  label: string;
  description: string;
  formatted: string;
  priorFormatted: string;
  /** Percentage change against the prior window; null when either side is n/a. */
  changePct: number | null;
  higherIsBetter: boolean;
}

export interface OverviewResult {
  intent: OverviewIntent;
  period: DateRange;
  priorPeriod: DateRange;
  live: OverviewTile[];
  matured: OverviewTile[];
  /** The window the outcome tiles describe, which may not be the one asked for. */
  maturedPeriod: DateRange;
  /** True when the requested window was too recent for outcomes to have resolved. */
  maturedIsLagged: boolean;
  queries: ResultSet["meta"]["queries"];
  notes: string[];
  ms: number;
}

/**
 * Which windows the two blocks cover.
 *
 * Pure, and separated out because it is the only decision in this file that can
 * be wrong in a way a reader would not notice.
 */
export function overviewWindows(
  period: DateRange,
  today: string,
): { maturedPeriod: DateRange; lagged: boolean } {
  const latestMature = shiftDays(today, -MATURATION_DAYS);
  // A window that already closed long enough ago needs no shifting: the
  // question asked about a cohort that has finished converting.
  if (period.to <= latestMature) return { maturedPeriod: period, lagged: false };

  const length = rangeDays(period);
  return {
    maturedPeriod: { from: shiftDays(latestMature, -(length - 1)), to: latestMature },
    lagged: true,
  };
}

/**
 * Run one metric over one window.
 *
 * Reports itself skipped when this metric cannot carry the requested filters -
 * `cpl` and `cac` read channel spend, so a filter on a lead field makes no
 * sense for them. Building the intent and letting `validateIntent` refuse it is the check
 * itself: a metric is in the overview exactly when a valid query for it exists,
 * which means this cannot drift from the rules the single-metric path follows.
 */
async function tile(
  ds: DataSource,
  id: MetricId,
  range: DateRange,
  filters: Filter[],
): Promise<{ tile: OverviewTile; queries: ResultSet["meta"]["queries"] } | { skipped: string }> {
  const def = METRICS[id];
  let intent;
  try {
    intent = validateIntent({
      metric: id,
      grain: "total",
      dateRange: range,
      dimensions: [],
      filters,
      // Always. See `OverviewIntentSchema` - the comparison is what makes this
      // an answer to "how did it go" rather than a list of numbers.
      compareTo: "previous_period",
      limit: 1,
    });
  } catch (e) {
    if (e instanceof IntentError) return { skipped: def.label };
    throw e;
  }

  const result = await execute(ds, intent);
  const total = result.total;
  const ratio = total?.comparison?.ratio ?? null;
  return {
    tile: {
      id,
      label: def.label,
      description: def.description,
      formatted: total?.formatted ?? "n/a",
      priorFormatted: total?.comparison?.formatted ?? "n/a",
      changePct: ratio === null ? null : ratio * 100 - 100,
      higherIsBetter: def.higherIsBetter,
    },
    queries: result.meta.queries,
  };
}

export async function runOverview(
  ds: DataSource,
  intent: OverviewIntent,
  today: string,
): Promise<OverviewResult> {
  const t0 = Date.now();
  const { maturedPeriod, lagged } = overviewWindows(intent.dateRange, today);

  const blocks = await Promise.all([
    Promise.all(OVERVIEW_LIVE.map((id) => tile(ds, id, intent.dateRange, intent.filters))),
    Promise.all(OVERVIEW_MATURED.map((id) => tile(ds, id, maturedPeriod, intent.filters))),
  ]);

  const queries: ResultSet["meta"]["queries"] = [];
  const skipped: string[] = [];
  const kept = blocks.map((block) => {
    const tiles: OverviewTile[] = [];
    for (const r of block) {
      if ("skipped" in r) {
        skipped.push(r.skipped);
        continue;
      }
      tiles.push(r.tile);
      queries.push(...r.queries);
    }
    return tiles;
  });

  const notes: string[] = [];
  if (lagged) {
    notes.push(
      `Conversion, CAC and time-to-convert are shown for ${maturedPeriod.from} to ${maturedPeriod.to} - ` +
        `a window of the same length that closed more than ${MATURATION_DAYS} days ago. ` +
        `The requested window is too recent for those outcomes to have resolved.`,
    );
  }
  if ((kept[0] ?? []).length === 0) {
    // Should be unreachable - `validateOverview` rejects the filter set that
    // used to cause it - but an empty card that looks like a working answer is
    // the one outcome worth being loud about.
    notes.push("No metric could be reported for this window with these filters.");
  }
  if (skipped.length > 0) {
    notes.push(
      `${skipped.join(" and ")} ${skipped.length === 1 ? "is" : "are"} omitted: ` +
        `${skipped.length === 1 ? "it comes" : "they come"} from channel spend, which cannot be filtered by a lead field.`,
    );
  }

  return {
    intent,
    period: intent.dateRange,
    priorPeriod: previousOf(intent),
    live: kept[0] ?? [],
    matured: kept[1] ?? [],
    maturedPeriod,
    maturedIsLagged: lagged,
    queries,
    notes,
    ms: Date.now() - t0,
  };
}

function previousOf(intent: OverviewIntent): DateRange {
  const length = rangeDays(intent.dateRange);
  const to = shiftDays(intent.dateRange.from, -1);
  return { from: shiftDays(to, -(length - 1)), to };
}

/**
 * The summary, computed rather than written.
 *
 * Seven numbers with their deltas do not need a model to describe them, and a
 * model asked to describe them will reach for a cause it cannot see. What a
 * reader needs is which way things moved and by how much, which is arithmetic.
 */
export function overviewSummary(result: OverviewResult): { headline: string; narrative: string } {
  const { period } = result;
  const span = period.from === period.to ? period.from : `${period.from} to ${period.to}`;
  const leads = result.live.find((t) => t.id === "leads_created");
  const headline = leads
    ? `${leads.formatted} leads, ${span}`
    : `Pipeline overview, ${span}`;

  // Up is not good and down is not bad: it depends on the metric, which is why
  // every tile carries its own polarity rather than the caller assuming one.
  const moved = [...result.live, ...result.matured]
    .filter((t) => t.changePct !== null && Math.abs(t.changePct) >= 5)
    .sort((a, b) => Math.abs(b.changePct!) - Math.abs(a.changePct!))
    .slice(0, 3)
    .map((t) => ({ tile: t, good: t.changePct! > 0 === t.higherIsBetter }));

  const allOneWay = moved.length > 1 && moved.every((m) => m.good === moved[0]!.good);
  const phrase = moved.map(({ tile: t, good }) => {
    const direction = t.changePct! >= 0 ? "up" : "down";
    // Marking each one individually reads as a stutter when they all agree, so
    // when they do, it is said once at the end instead.
    const polarity = good || allOneWay ? "" : " (the wrong way)";
    return `${t.label} ${direction} ${Math.abs(t.changePct!).toFixed(0)}%${polarity} at ${t.formatted}`;
  });

  const parts: string[] = [];
  if (result.live.length > 0) {
    parts.push(`${result.live.map((t) => `${t.label} ${t.formatted}`).join(", ")}.`);
  }
  if (moved.length > 0) {
    const verdict = allOneWay ? (moved[0]!.good ? ", all in your favour" : ", all the wrong way") : "";
    parts.push(`Against the window before it: ${phrase.join("; ")}${verdict}.`);
  } else {
    parts.push("Nothing moved more than 5% against the window before it.");
  }
  if (result.maturedIsLagged) {
    parts.push(
      `Outcome metrics describe ${result.maturedPeriod.from} to ${result.maturedPeriod.to}, which has had time to convert.`,
    );
  }
  return { headline, narrative: parts.join(" ") };
}
