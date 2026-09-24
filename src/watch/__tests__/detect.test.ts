/**
 * Unit tests for the detectors, on hand-built cells. No database.
 *
 * The case that matters most is the last block: a uniform market-wide drop must
 * produce nothing at segment level. Everything else in the Watchtower is
 * downstream of getting that right.
 */
import { describe, expect, it } from "vitest";
import { detectEfficiency, detectRate, detectVolume, GATES } from "../detect";
import type { Cell, Counts, MarketFactors } from "../findings";

const counts = (units: number, events = 0, spend: number | null = null): Counts => ({
  units,
  events,
  spend,
});

const market = (over: Partial<MarketFactors> = {}): MarketFactors => ({
  volume: 1,
  rate: 1,
  efficiency: 1,
  baselineUnits: 1000,
  ...over,
});

const cell = (over: Partial<Cell>): Cell => ({
  detector: "volume",
  dimension: "lead_source",
  member: "Google",
  segmentWindow: counts(100),
  segmentBaseline: counts(400),
  market: market(),
  window: { from: "2026-06-01", to: "2026-06-28" },
  baseline: { from: "2026-02-09", to: "2026-05-31" },
  windowDays: 28,
  baselineDays: 112,
  ...over,
});

describe("detectVolume", () => {
  it("finds nothing when the segment tracks its own baseline", () => {
    const r = detectVolume(cell({ segmentWindow: counts(100), segmentBaseline: counts(400) }))!;
    expect(r.effect).toBeCloseTo(1, 6);
    expect(r.p).toBeGreaterThan(0.5);
  });

  it("flags a segment that halves", () => {
    const r = detectVolume(cell({ segmentWindow: counts(50) }))!;
    expect(r.effect).toBeCloseTo(0.5, 6);
    expect(r.p).toBeLessThan(1e-5);
    expect(r.impactUnits).toBeCloseTo(50, 6);
  });

  it("skips a baseline too thin to extrapolate from", () => {
    expect(detectVolume(cell({ segmentBaseline: counts(GATES.volumeBaselineUnits - 1) }))).toBeNull();
  });

  it("skips when the baseline predicts too few leads to test", () => {
    expect(
      detectVolume(cell({ segmentBaseline: counts(32), windowDays: 7, baselineDays: 112 })),
    ).toBeNull();
  });
});

describe("detectRate", () => {
  const rateCell = (over: Partial<Cell> = {}) =>
    cell({
      detector: "conversion",
      segmentWindow: counts(200, 72),
      segmentBaseline: counts(800, 288), // 36%
      ...over,
    });

  it("finds nothing when the rate holds", () => {
    const r = detectRate(rateCell())!;
    expect(r.effect).toBeCloseTo(1, 6);
    expect(r.p).toBeGreaterThan(0.5);
  });

  it("flags a collapse and counts the conversions lost", () => {
    const r = detectRate(rateCell({ segmentWindow: counts(200, 20) }))!;
    expect(r.effect).toBeCloseTo(20 / 72, 6);
    expect(r.p).toBeLessThan(1e-10);
    expect(r.impactUnits).toBeCloseTo(52, 6);
  });

  it("flags a lift too - an improvement is news", () => {
    const r = detectRate(rateCell({ segmentWindow: counts(200, 120) }))!;
    expect(r.effect).toBeGreaterThan(1.6);
    expect(r.p).toBeLessThan(1e-6);
  });

  it("is unaffected by the segment merely getting quieter", () => {
    // Half the leads, same conversion rate: the volume detector's business,
    // not this one's.
    const r = detectRate(rateCell({ segmentWindow: counts(100, 36) }))!;
    expect(r.effect).toBeCloseTo(1, 6);
    expect(r.p).toBeGreaterThan(0.5);
  });

  it("skips a window too small for a rate to mean anything", () => {
    expect(detectRate(rateCell({ segmentWindow: counts(GATES.rateWindowUnits - 1, 2) }))).toBeNull();
  });

  it("skips a baseline too small to extrapolate a rate from", () => {
    expect(detectRate(rateCell({ segmentBaseline: counts(50, 18) }))).toBeNull();
  });
});

describe("detectEfficiency", () => {
  const effCell = (over: Partial<Cell> = {}) =>
    cell({
      detector: "efficiency",
      dimension: "channel",
      // Baseline: 100 conversions for 65,590 rupees - CAC about 656.
      segmentBaseline: counts(400, 100, 65_590),
      segmentWindow: counts(156, 50, 90_541),
      ...over,
    });

  it("reproduces the planted CAC blow-out", () => {
    // 90,541 rupees at the baseline efficiency should have bought ~138
    // conversions; it bought 50, so CAC roughly tripled.
    const r = detectEfficiency(effCell())!;
    expect(r.expected).toBeCloseTo(138, 0);
    expect(r.observed).toBe(50);
    expect(r.p).toBeLessThan(1e-10);
    expect(1 / r.effect).toBeGreaterThan(2.5); // CAC ratio
  });

  it("finds nothing when spend and yield rise together", () => {
    const r = detectEfficiency(effCell({ segmentWindow: counts(400, 138, 90_541) }))!;
    expect(r.effect).toBeCloseTo(1, 1);
    expect(r.p).toBeGreaterThan(0.5);
  });

  it("skips a channel with no lead-side counterpart", () => {
    // Bing has spend but its leads were folded into `Other` in Phase 0.
    expect(detectEfficiency(effCell({ segmentBaseline: counts(0, 0, 40_000) }))).toBeNull();
  });

  it("skips when spend is not tracked at all", () => {
    expect(detectEfficiency(effCell({ segmentBaseline: counts(400, 100, null) }))).toBeNull();
  });
});

describe("the market factor is what separates a fault from the weather", () => {
  it("raises nothing when the segment falls exactly as far as the market", () => {
    // The whole pipeline halves; this segment halves. Nothing broke here.
    const r = detectVolume(
      cell({ segmentWindow: counts(50), market: market({ volume: 0.5 }) }),
    )!;
    expect(r.effect).toBeCloseTo(1, 6);
    expect(r.p).toBeGreaterThan(0.5);
  });

  it("raises a segment that falls while the market holds", () => {
    const r = detectVolume(cell({ segmentWindow: counts(50), market: market({ volume: 1 }) }))!;
    expect(r.p).toBeLessThan(1e-5);
  });

  it("raises a segment that merely fails to join a market recovery", () => {
    // Everyone else is up 50%; this segment is flat. That is a real shortfall.
    const r = detectVolume(cell({ segmentWindow: counts(100), market: market({ volume: 1.5 }) }))!;
    expect(r.effect).toBeCloseTo(1 / 1.5, 6);
    expect(r.p).toBeLessThan(1e-3);
  });

  it("ignores a control arm too small to believe", () => {
    const r = detectVolume(
      cell({
        segmentWindow: counts(50),
        market: market({ volume: 0.5, baselineUnits: GATES.controlUnits - 1 }),
      }),
    )!;
    expect(r.marketFactor).toBe(1);
    expect(r.p).toBeLessThan(1e-5);
  });

  it("treats the global cell as uncontrolled rather than guessing", () => {
    const r = detectVolume(cell({ dimension: null, member: null, segmentWindow: counts(50), market: null }))!;
    expect(r.marketFactor).toBe(1);
  });

  it("applies the same logic to rates", () => {
    const r = detectRate(
      cell({
        detector: "conversion",
        segmentWindow: counts(200, 36),
        segmentBaseline: counts(800, 288),
        market: market({ rate: 0.5 }),
      }),
    )!;
    expect(r.effect).toBeCloseTo(1, 6);
    expect(r.p).toBeGreaterThan(0.5);
  });
});
