/**
 * Turns date ranges into cells for the detectors.
 *
 * Everything here goes through the Phase 1 semantic layer. The Watchtower
 * cannot ask the database anything the Analyst cannot, and both read the same
 * metric definitions - a detector that quietly disagreed about what
 * "conversion rate" means would be worse than no detector, because the alert
 * and the investigation would contradict each other.
 */
import type { DataSource } from "../db/types";
import { runFlat, UNKNOWN, type ResultRow } from "../semantic/execute";
import { validateIntent } from "../semantic/intent";
import type { DateRange } from "../semantic/dates";
import type { Cell, Counts, DetectorId, MarketFactors } from "./findings";

/** One (detector, dimension) pair to sweep, and the metric that feeds it. */
export interface Spec {
  detector: DetectorId;
  metric: "conversion_rate_21d" | "cac" | "leads_created";
  dimension: "lead_source" | "lead_origin" | "channel" | null;
  /**
   * `live` reads up to yesterday. `matured` ends `MATURATION_DAYS` earlier,
   * because an outcome you cannot have observed yet is not a signal.
   */
  lag: "live" | "matured";
}

/**
 * Window lengths per lag family.
 *
 * Volume gets a 7-day scale because a sharp outage shows up in counts within
 * days. Outcomes do not: a 7-day conversion bucket for a mid-size channel is
 * twenty-odd leads, where the binomial has almost no power and every firing is
 * noise. Dropping it also returns a third of the multiple-comparison budget.
 */
export const WINDOWS: Record<Spec["lag"], number[]> = {
  live: [7, 14, 28],
  matured: [14, 28],
};

/**
 * The sweep.
 *
 * Two deliberate absences:
 *
 * **Volume runs `live`, outcomes run `matured`.** A lead either arrived
 * yesterday or it did not, so volume faults are detectable the next morning.
 * Whether a lead converts is not knowable for weeks, and the lag differs about
 * sixfold by channel - so the outcome detectors read a window that ends
 * `MATURATION_DAYS` ago, against a bounded-horizon rate. The cost is stated
 * plainly rather than hidden: **conversion and efficiency problems surface
 * about three weeks late.** The alternative is a detector that fires on
 * cohort maturation and gets switched off in a fortnight.
 *
 * **No SLA detector.** Rep-level breach rate is confounded by lead mix and
 * load in a way this difference-in-differences does not model - a rep whose
 * channel mix shifts shows a breach-rate move that is real and not their
 * doing. Every firing in testing was a false positive, and it burned a third
 * of the multiple-comparison budget doing it. `detectRate` still handles it if
 * you want it; adding a line here is all it takes.
 */
export const SPECS: Spec[] = [
  { detector: "volume", metric: "leads_created", dimension: "lead_source", lag: "live" },
  { detector: "volume", metric: "leads_created", dimension: "lead_origin", lag: "live" },
  { detector: "volume", metric: "leads_created", dimension: null, lag: "live" },
  { detector: "conversion", metric: "conversion_rate_21d", dimension: "lead_source", lag: "matured" },
  { detector: "conversion", metric: "conversion_rate_21d", dimension: "lead_origin", lag: "matured" },
  { detector: "conversion", metric: "conversion_rate_21d", dimension: null, lag: "matured" },
  { detector: "efficiency", metric: "cac", dimension: "channel", lag: "matured" },
  { detector: "efficiency", metric: "cac", dimension: null, lag: "matured" },
];

/** How each metric's support columns become the detector's units and events. */
function countsOf(metric: Spec["metric"], row: ResultRow): Counts {
  const s = row.support;
  switch (metric) {
    case "leads_created":
      return { units: s.n ?? 0, events: 0, spend: null };
    case "conversion_rate_21d":
      return { units: s.n ?? 0, events: s.won ?? 0, spend: null };
    case "cac":
      return { units: s.n ?? 0, events: s.won ?? 0, spend: s.spend ?? 0 };
  }
}

const EMPTY: Counts = { units: 0, events: 0, spend: null };

/**
 * How the control arm - every member of this dimension except `exclude` -
 * moved, by direct standardisation.
 *
 * For rates and efficiency the control's expectation is rebuilt member by
 * member from its own baseline rate applied to its actual window exposure.
 * The factor is then what the control really did divided by that. A pooled
 * ratio would instead shift whenever the control's composition shifts, which
 * is how a surge in one high-converting channel used to make every other
 * channel look broken.
 *
 * Volume has no denominator to standardise, so it stays a pooled leads-per-day
 * ratio - which is what "the market" means for volume anyway.
 */
function marketFactors(
  windowByMember: Map<string, Counts>,
  baselineByMember: Map<string, Counts>,
  exclude: string,
  windowDays: number,
  baselineDays: number,
): MarketFactors {
  let winUnits = 0, baseUnits = 0;
  let winEvents = 0, expectedEvents = 0;
  let winSpendEvents = 0, expectedSpendEvents = 0;

  for (const [member, base] of baselineByMember) {
    if (member === exclude) continue;
    const win = windowByMember.get(member);
    if (!win) continue;

    winUnits += win.units;
    baseUnits += base.units;

    if (base.units > 0) {
      winEvents += win.events;
      expectedEvents += win.units * (base.events / base.units);
    }
    if (base.spend !== null && base.spend > 0 && win.spend !== null) {
      winSpendEvents += win.events;
      expectedSpendEvents += win.spend * (base.events / base.spend);
    }
  }

  const perDayWin = windowDays > 0 ? winUnits / windowDays : 0;
  const perDayBase = baselineDays > 0 ? baseUnits / baselineDays : 0;

  return {
    volume: perDayBase > 0 ? perDayWin / perDayBase : 1,
    rate: expectedEvents > 0 ? winEvents / expectedEvents : 1,
    efficiency: expectedSpendEvents > 0 ? winSpendEvents / expectedSpendEvents : 1,
    baselineUnits: baseUnits,
  };
}

/**
 * Memoised fetch. The volume and conversion detectors over the same dimension
 * want identical rows, and each range is queried once per scan rather than once
 * per detector.
 */
export function createFetcher(ds: DataSource) {
  const cache = new Map<string, Promise<ResultRow[]>>();
  return (metric: Spec["metric"], dimension: string | null, range: DateRange): Promise<ResultRow[]> => {
    const key = `${metric}|${dimension ?? ""}|${range.from}|${range.to}`;
    let hit = cache.get(key);
    if (!hit) {
      const intent = validateIntent({
        metric,
        grain: "total",
        dateRange: range,
        dimensions: dimension ? [dimension] : [],
        filters: [],
        compareTo: "none",
        limit: 100,
      });
      hit = runFlat(ds, intent, range);
      cache.set(key, hit);
    }
    return hit;
  };
}

/** `REP007 · Aarti Deshpande` reads better in an alert than `REP007`. */
function memberOf(dimension: string, row: ResultRow): string {
  return row.dims[dimension] ?? UNKNOWN;
}

export interface SweepRange {
  window: DateRange;
  baseline: DateRange;
  windowDays: number;
  baselineDays: number;
}

/**
 * Build every cell for one window/baseline pair.
 *
 * The control arm is assembled from the *other* members of the same dimension
 * rather than by running a second query. Exact for these dimensions - every
 * lead carries a `lead_source` and a `lead_origin` - and it keeps the
 * per-member detail that direct standardisation needs.
 */
export type Fetcher = ReturnType<typeof createFetcher>;

export async function observe(
  fetch: Fetcher,
  sweep: SweepRange,
  specs: Spec[] = SPECS,
): Promise<Cell[]> {
  const cells: Cell[] = [];

  for (const spec of specs) {
    const [windowRows, baselineRows] = await Promise.all([
      fetch(spec.metric, spec.dimension, sweep.window),
      fetch(spec.metric, spec.dimension, sweep.baseline),
    ]);

    const base = {
      detector: spec.detector,
      dimension: spec.dimension,
      window: sweep.window,
      baseline: sweep.baseline,
      windowDays: sweep.windowDays,
      baselineDays: sweep.baselineDays,
    };

    if (spec.dimension === null) {
      // The whole-population cell. No control exists, and that is the point:
      // anything it finds is a market move, not a fault.
      cells.push({
        ...base,
        member: null,
        segmentWindow: windowRows[0] ? countsOf(spec.metric, windowRows[0]) : EMPTY,
        segmentBaseline: baselineRows[0] ? countsOf(spec.metric, baselineRows[0]) : EMPTY,
        market: null,
      });
      continue;
    }

    const dim = spec.dimension;
    const windowByMember = new Map(windowRows.map((r) => [memberOf(dim, r), countsOf(spec.metric, r)]));
    const baselineByMember = new Map(baselineRows.map((r) => [memberOf(dim, r), countsOf(spec.metric, r)]));
    for (const member of new Set([...windowByMember.keys(), ...baselineByMember.keys()])) {
      cells.push({
        ...base,
        member,
        segmentWindow: windowByMember.get(member) ?? EMPTY,
        segmentBaseline: baselineByMember.get(member) ?? EMPTY,
        market: marketFactors(
          windowByMember,
          baselineByMember,
          member,
          sweep.windowDays,
          sweep.baselineDays,
        ),
      });
    }
  }

  return cells;
}
