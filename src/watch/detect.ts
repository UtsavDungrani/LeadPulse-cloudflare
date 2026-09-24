/**
 * The detectors. Pure: counts in, test result out. No database, no model.
 *
 * Every detector is a **difference-in-differences** test. The naive version -
 * "this segment is down 40% on its own baseline" - cannot tell a broken landing
 * page from a public holiday, because both look identical from inside a single
 * segment. So each segment is tested against what its own baseline predicts
 * *after* applying the concurrent move in the rest of the population:
 *
 *     expected = segment_baseline_rate x window_length x market_factor
 *     market_factor = control_window_rate / control_baseline_rate
 *
 * When every segment falls together the market factor absorbs the fall,
 * `expected` drops with it, and nothing is flagged. When one segment falls
 * alone the market factor stays near 1 and the divergence is the whole signal.
 *
 * The control arm is the rest of the population *excluding* the segment under
 * test. Including it lets a dominant channel contaminate its own control.
 */
import { poissonTwoSidedP, binomialTwoSidedP } from "./stats";
import type { Cell, Counts, TestResult } from "./findings";

/**
 * Support gates. Below these the test is not underpowered so much as
 * meaningless, and a detector that fires on four leads is a detector nobody
 * trusts. Cells that fail a gate are skipped, not silently passed.
 */
export const GATES = {
  /** Leads in the baseline before a volume cell is testable. */
  volumeBaselineUnits: 30,
  /** Leads the baseline must predict for the window. */
  volumeExpected: 8,
  /** Leads in the baseline before a rate is stable enough to extrapolate. */
  rateBaselineUnits: 100,
  /** Leads in the window before a rate means anything. */
  rateWindowUnits: 25,
  /** Conversions in the baseline before spend efficiency is estimable. */
  efficiencyBaselineEvents: 15,
  /** Conversions the baseline predicts the window's spend should buy. */
  efficiencyExpected: 8,
  /** Control-arm size below which the market factor is not trusted and 1 is used. */
  controlUnits: 50,
} as const;

const perDay = (c: Counts, days: number): number => (days > 0 ? c.units / days : 0);
const rateOf = (c: Counts): number | null => (c.units > 0 ? c.events / c.units : null);

/**
 * Read one axis of the control's concurrent move.
 *
 * Falls back to 1 - "the market held still" - for the global cell, for a
 * control arm too small to believe, and for a factor that came out
 * non-finite. The caller records the value it used, so an uncontrolled test is
 * visible in the finding rather than silently indistinguishable.
 */
function marketFactor(cell: Cell, axis: "volume" | "rate" | "efficiency"): number {
  const m = cell.market;
  if (!m || m.baselineUnits < GATES.controlUnits) return 1;
  const f = m[axis];
  return Number.isFinite(f) && f > 0 ? f : 1;
}

/**
 * Volume: did this segment receive the number of leads its own history and the
 * current market predict? Counts are Poisson, so the test is Poisson.
 */
export function detectVolume(cell: Cell): TestResult | null {
  const base = cell.segmentBaseline;
  if (base.units < GATES.volumeBaselineUnits) return null;

  const market = marketFactor(cell, "volume");
  const expected = perDay(base, cell.baselineDays) * cell.windowDays * market;
  if (expected < GATES.volumeExpected) return null;

  const observed = cell.segmentWindow.units;
  return {
    observed,
    expected,
    effect: expected > 0 ? observed / expected : 1,
    marketFactor: market,
    p: poissonTwoSidedP(observed, expected),
    impactUnits: Math.abs(observed - expected),
    unit: "leads",
  };
}

/**
 * Rates (conversion, SLA breach): did this segment convert - or breach - at the
 * rate predicted, given how many leads it actually got? Conditioning on the
 * observed denominator is what keeps this test independent of the volume test,
 * so a channel that merely got quieter does not also register as converting
 * worse.
 */
export function detectRate(cell: Cell): TestResult | null {
  const base = cell.segmentBaseline;
  const win = cell.segmentWindow;
  if (base.units < GATES.rateBaselineUnits || win.units < GATES.rateWindowUnits) return null;

  const baseRate = rateOf(base);
  if (baseRate === null) return null;

  const market = marketFactor(cell, "rate");
  const expectedRate = Math.min(1 - 1e-9, Math.max(1e-9, baseRate * market));
  const expected = expectedRate * win.units;
  const observed = win.events;

  return {
    observed,
    expected,
    effect: expected > 0 ? observed / expected : 1,
    marketFactor: market,
    p: binomialTwoSidedP(observed, win.units, expectedRate),
    impactUnits: Math.abs(observed - expected),
    unit: cell.detector === "sla" ? "breaches" : "conversions",
  };
}

/**
 * Efficiency: did the money buy the conversions it used to?
 *
 * Framed as conversions-per-rupee rather than as cost-per-conversion, because
 * the uncertainty lives entirely in the conversion count - spend is measured
 * exactly. That makes it another Poisson test, and it means a spend increase
 * with flat yield shows up immediately: expected conversions scale with spend,
 * observed ones do not follow.
 */
export function detectEfficiency(cell: Cell): TestResult | null {
  const base = cell.segmentBaseline;
  const win = cell.segmentWindow;
  if (base.spend === null || win.spend === null) return null;
  if (base.spend <= 0 || win.spend <= 0) return null;
  if (base.events < GATES.efficiencyBaselineEvents) return null;

  const baseEfficiency = base.events / base.spend;
  const market = marketFactor(cell, "efficiency");
  const expected = win.spend * baseEfficiency * market;
  if (expected < GATES.efficiencyExpected) return null;

  const observed = win.events;
  return {
    observed,
    expected,
    effect: expected > 0 ? observed / expected : 1,
    marketFactor: market,
    p: poissonTwoSidedP(observed, expected),
    impactUnits: Math.abs(observed - expected),
    unit: "conversions",
  };
}

export function runDetector(cell: Cell): TestResult | null {
  switch (cell.detector) {
    case "volume":
      return detectVolume(cell);
    case "conversion":
    case "sla":
      return detectRate(cell);
    case "efficiency":
      return detectEfficiency(cell);
  }
}
