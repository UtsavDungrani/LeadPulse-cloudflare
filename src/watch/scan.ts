/**
 * The sweep: pick windows, build cells, test them, control the false-discovery
 * rate, and hand back a ranked feed.
 *
 * Deliberately deterministic end to end. Given the same database and the same
 * `asOf`, this returns byte-identical findings - which is what makes the
 * planted-incident eval meaningful, and what lets someone re-run a scan to
 * check an alert rather than take it on faith.
 */
import type { DataSource } from "../db/types";
import { fmtDay, shiftDays, toDay, type DateRange } from "../semantic/dates";
import { createFetcher, observe, SPECS, WINDOWS, type Fetcher, type SweepRange } from "./observe";
import { MATURATION_DAYS } from "../semantic/metrics";
import { runDetector } from "./detect";
import { benjaminiHochberg } from "./stats";
import { describe, findingKey, type Cell, type Finding, type TestResult } from "./findings";

export interface ScanOptions {
  /** Treat this as "now". The scan reads up to the previous full day. */
  asOf?: Date;
  /**
   * Override the trailing window lengths for every detector. Normally each lag
   * family picks its own - see `WINDOWS` in `observe.ts`.
   */
  windows?: number[];
  /** Benjamini-Hochberg target false-discovery rate. */
  fdrQ?: number;
  /** Earliest date with data, so baselines do not run off the start. */
  dataStart?: string;
  /** Cap on findings returned. */
  limit?: number;
  /** Set false to report every statistically significant cell, floors included. */
  applyMaterialityFloor?: boolean;
}

/**
 * Significance is necessary and not sufficient.
 *
 * With enough leads a 3% shift is detectable, and nobody wants to be woken for
 * one. An alert has to clear both bars: unlikely to be chance, *and* large
 * enough that a person would do something about it.
 */
export const FLOORS = {
  /** Minimum |effect - 1|. A 20% miss against expectation. */
  effect: 0.2,
  /** Minimum absolute shortfall or excess, by unit. */
  units: { leads: 15, conversions: 8, breaches: 8 } as Record<string, number>,
};

export interface ScanReport {
  asOf: string;
  findings: Finding[];
  stats: {
    cellsConsidered: number;
    testsRun: number;
    testsSkipped: number;
    passedFdr: number;
    fdrThreshold: number | null;
    windows: SweepRange[];
  };
  ms: number;
}

const DEFAULT_Q = 0.05;

/**
 * Baseline length as a multiple of the window.
 *
 * Four-to-one is the trade: long enough that the baseline rate is stable,
 * short enough that a change six months ago is not still being averaged into
 * today's expectation.
 */
const BASELINE_MULTIPLE = 4;
const MIN_BASELINE_DAYS = 28;

export function sweepRanges(asOf: Date, windows: number[], dataStart?: string): SweepRange[] {
  // Read up to the previous full day: today is partial, and a half-day of
  // leads reads as a catastrophic volume drop every single morning.
  const lastFullDay = fmtDay(new Date(asOf.getTime() - 86_400_000));

  return windows
    .map((windowDays) => {
      const window: DateRange = { from: shiftDays(lastFullDay, -(windowDays - 1)), to: lastFullDay };
      const wantedBaseline = Math.max(MIN_BASELINE_DAYS, windowDays * BASELINE_MULTIPLE);
      const baselineTo = shiftDays(window.from, -1);
      let baselineFrom = shiftDays(baselineTo, -(wantedBaseline - 1));
      if (dataStart && toDay(baselineFrom) < toDay(dataStart)) baselineFrom = dataStart;

      const baselineDays =
        Math.round((toDay(baselineTo).getTime() - toDay(baselineFrom).getTime()) / 86_400_000) + 1;
      return { window, baseline: { from: baselineFrom, to: baselineTo }, windowDays, baselineDays };
    })
    .filter((r) => r.baselineDays >= MIN_BASELINE_DAYS);
}

interface Candidate {
  cell: Cell;
  test: TestResult;
}

export async function scan(ds: DataSource, opts: ScanOptions = {}): Promise<ScanReport> {
  const t0 = Date.now();
  const asOf = opts.asOf ?? new Date();
  const override = opts.windows;
  const fetch: Fetcher = createFetcher(ds);

  const families = (["live", "matured"] as const).map((lag) => ({
    lag,
    specs: SPECS.filter((s) => s.lag === lag),
    // Outcomes read a window that has had time to resolve; volume reads to
    // yesterday. The lag is applied to `asOf` rather than to the finished
    // ranges, so the clamp against `dataStart` sees the dates that will
    // actually be queried - shifting afterwards walks the baseline off the
    // start of the data.
    ranges: sweepRanges(
      lag === "matured" ? new Date(asOf.getTime() - MATURATION_DAYS * 86_400_000) : asOf,
      override ?? WINDOWS[lag],
      opts.dataStart,
    ),
  }));

  const candidates: Candidate[] = [];
  let considered = 0;
  let skipped = 0;

  for (const family of families) {
    for (const range of family.ranges) {
      const cells = await observe(fetch, range, family.specs);
      considered += cells.length;
      for (const cell of cells) {
        const test = runDetector(cell);
        if (!test) {
          skipped++;
          continue;
        }
        candidates.push({ cell, test });
      }
    }
  }

  // Control the false-discovery rate across the *whole* sweep, every window
  // included. Choosing the best window first and testing afterwards would be
  // the classic way to manufacture significance out of noise.
  const { passed, threshold } = benjaminiHochberg(candidates, (c) => c.test.p, opts.fdrQ ?? DEFAULT_Q);

  // One finding per cell: the same drop seen through a 7-, 14- and 28-day
  // window is one problem, not three. Keep the window that saw it most clearly.
  const best = new Map<string, Candidate>();
  for (const c of passed) {
    const key = findingKey(c.cell.detector, c.cell.dimension, c.cell.member);
    const current = best.get(key);
    if (!current || c.test.p < current.test.p) best.set(key, c);
  }

  const floored = opts.applyMaterialityFloor === false ? [...best.values()] : [...best.values()].filter(isMaterial);
  const findings = floored
    .map((c) => toFinding(findingKey(c.cell.detector, c.cell.dimension, c.cell.member), c))
    .sort((a, b) => b.impactUnits - a.impactUnits)
    .slice(0, opts.limit ?? 25);

  return {
    asOf: asOf.toISOString(),
    findings,
    stats: {
      cellsConsidered: considered,
      testsRun: candidates.length,
      testsSkipped: skipped,
      passedFdr: passed.length,
      fdrThreshold: threshold,
      windows: families.flatMap((f) => f.ranges),
    },
    ms: Date.now() - t0,
  };
}

function isMaterial({ test }: Candidate): boolean {
  const floor = FLOORS.units[test.unit] ?? 0;
  return Math.abs(test.effect - 1) >= FLOORS.effect && test.impactUnits >= floor;
}

function toFinding(key: string, { cell, test }: Candidate): Finding {
  const core = {
    ...test,
    detector: cell.detector,
    // No control arm means no way to tell a fault from the weather. The global
    // cell is reported as market context, never as something that broke.
    kind: cell.dimension === null ? ("market_shift" as const) : ("incident" as const),
    direction: test.effect < 1 ? ("drop" as const) : ("surge" as const),
    dimension: cell.dimension,
    member: cell.member,
    window: cell.window,
    baseline: cell.baseline,
    support: {
      windowUnits: cell.segmentWindow.units,
      windowEvents: cell.segmentWindow.events,
      baselineUnits: cell.segmentBaseline.units,
      baselineEvents: cell.segmentBaseline.events,
    },
  };
  return { key, ...core, ...describe(core) };
}
