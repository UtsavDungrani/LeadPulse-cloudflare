/**
 * What the Watchtower produces, and how a finding ages.
 *
 * The central distinction in this file is `kind`:
 *
 *  - **`incident`** - a segment moved *relative to the rest of the population*.
 *    Something you own probably broke or improved. This is what pages someone.
 *  - **`market_shift`** - the whole population moved together, and no segment
 *    diverged. Nothing you own is channel-agnostic, so a uniform move is
 *    demand, not a fault. Worth reporting, not worth alerting.
 *
 * That distinction is the difference between a detector people keep enabled and
 * one they mute in a fortnight. The foundry plants a benign festive dip
 * precisely to test it: every source falls together, no segment diverges, and
 * it must come out the far end as context rather than an alert.
 */
import type { DateRange } from "../semantic/dates";

export const DETECTORS = ["volume", "conversion", "sla", "efficiency"] as const;
export type DetectorId = (typeof DETECTORS)[number];

export type FindingKind = "incident" | "market_shift";
export type Direction = "drop" | "surge";
export type FindingStatus = "new" | "ongoing" | "resolved";

/** Raw counts for one cell over one date range. */
export interface Counts {
  /** Population: leads created in the range. */
  units: number;
  /** Events among them: conversions, or SLA breaches. */
  events: number;
  /** Media spend, for the efficiency detector. Null where spend is not tracked. */
  spend: number | null;
}

export interface Cell {
  detector: DetectorId;
  /** Null for the whole-population cell, which by definition has no control. */
  dimension: string | null;
  member: string | null;
  segmentWindow: Counts;
  segmentBaseline: Counts;
  /**
   * How the rest of the population moved, computed by `observe` where the
   * per-member detail still exists. Null for the global cell, which has no
   * control by definition.
   */
  market: MarketFactors | null;
  window: DateRange;
  baseline: DateRange;
  windowDays: number;
  baselineDays: number;
}

/**
 * The concurrent move in the control arm, on each axis a detector needs.
 *
 * Rates and efficiency are **directly standardised**: the expectation for the
 * control is rebuilt from each member's own baseline rate applied to its actual
 * window volume, then compared with what the control really did. A pooled
 * ratio would instead move whenever the control's *mix* moves - and it does.
 * When a 92%-converting channel surges, the pooled control rate climbs for
 * purely compositional reasons, every other channel is measured against an
 * inflated expectation, and the detector reports a conversion collapse that
 * never happened. That is Simpson's paradox, and it produced a fortnight of
 * identical false alerts before this was fixed.
 */
export interface MarketFactors {
  /** Leads per day in the control, window over baseline. */
  volume: number;
  /** Control events over what its own baseline rates predict for this mix. */
  rate: number;
  /** Control conversions over what its own baseline efficiency predicts. */
  efficiency: number;
  /** Baseline size of the control arm, used to decide whether to trust it. */
  baselineUnits: number;
}

export interface TestResult {
  observed: number;
  /** What the baseline predicts, after removing the concurrent market move. */
  expected: number;
  /** `observed / expected`. 1.0 is "exactly as predicted". */
  effect: number;
  /** How the control arm moved. 1.0 means the rest of the population held still. */
  marketFactor: number;
  p: number;
  /** `|observed - expected|`, in the detector's natural unit. */
  impactUnits: number;
  unit: "leads" | "conversions" | "breaches";
}

export interface Finding extends TestResult {
  /** Stable across scans, so a finding can be tracked rather than re-raised. */
  key: string;
  kind: FindingKind;
  detector: DetectorId;
  direction: Direction;
  dimension: string | null;
  member: string | null;
  window: DateRange;
  baseline: DateRange;
  /** Deterministic, always present. */
  headline: string;
  impact: string;
  /** Written by the model, when it is available. Never load-bearing. */
  narrative?: string;
  support: { windowUnits: number; windowEvents: number; baselineUnits: number; baselineEvents: number };
}

export interface TrackedFinding extends Finding {
  status: FindingStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Scans in a row this has fired. A one-scan blip reads differently from a trend. */
  scanCount: number;
  acknowledgedAt: string | null;
}

export function findingKey(detector: DetectorId, dimension: string | null, member: string | null): string {
  return `${detector}:${dimension ?? "all"}:${member ?? "all"}`;
}

const UNIT_LABEL: Record<TestResult["unit"], [string, string]> = {
  leads: ["lead", "leads"],
  conversions: ["conversion", "conversions"],
  breaches: ["breach", "breaches"],
};

function plural(n: number, unit: TestResult["unit"]): string {
  const [one, many] = UNIT_LABEL[unit];
  return `${Math.round(n).toLocaleString("en-IN")} ${Math.round(n) === 1 ? one : many}`;
}

/**
 * The sentence a reader sees first. Deterministic on purpose: if the narration
 * call fails, the alert is still legible and still correct.
 */
export function describe(f: Omit<Finding, "headline" | "impact" | "key">): { headline: string; impact: string } {
  const who = f.member ? `${f.member}` : "Overall";
  const pct = Math.abs(f.effect - 1) * 100;
  const dir = f.direction === "drop" ? "below" : "above";
  const move = `${pct.toFixed(0)}% ${dir} expected`;

  const headline = (() => {
    switch (f.detector) {
      case "volume":
        return `${who}: lead volume ${move}`;
      case "conversion":
        return `${who}: conversion ${move}`;
      case "sla":
        return `${who}: SLA breaches ${move}`;
      case "efficiency":
        return f.direction === "drop"
          ? `${who}: spend bought ${move} conversions`
          : `${who}: spend bought ${move} conversions`;
    }
  })();

  const gap = plural(f.impactUnits, f.unit);
  const verb = f.direction === "drop" ? "fewer than" : "more than";
  // The global cell has no control arm, so it must not claim one held steady.
  const market =
    f.kind === "market_shift"
      ? "measured against the pipeline's own recent history, with no segment to compare it against"
      : Math.abs(f.marketFactor - 1) < 0.05
        ? "while the rest of the pipeline held steady"
        : `after allowing for the rest of the pipeline moving ${(f.marketFactor * 100 - 100).toFixed(0)}%`;

  return {
    headline: f.kind === "market_shift" ? `${headline} (whole pipeline)` : headline,
    impact: `${gap} ${verb} expected over ${f.window.from} to ${f.window.to}, ${market}.`,
  };
}

/**
 * Fold a fresh scan into the findings already on record.
 *
 * Findings that fire again become `ongoing` rather than new alerts - re-raising
 * the same thing every scan is the other way a detector gets muted. Findings
 * that stop firing are marked `resolved` and kept for one pass so a reader sees
 * that it ended, then dropped.
 */
export function mergeFindings(
  previous: TrackedFinding[],
  fresh: Finding[],
  now: string,
  keep = 50,
): { tracked: TrackedFinding[]; newlyRaised: TrackedFinding[] } {
  const byKey = new Map(previous.map((f) => [f.key, f]));
  const freshKeys = new Set(fresh.map((f) => f.key));
  const newlyRaised: TrackedFinding[] = [];

  const tracked: TrackedFinding[] = fresh.map((f) => {
    const prior = byKey.get(f.key);
    if (!prior || prior.status === "resolved") {
      const raised: TrackedFinding = {
        ...f,
        status: "new",
        firstSeenAt: now,
        lastSeenAt: now,
        scanCount: 1,
        acknowledgedAt: null,
      };
      newlyRaised.push(raised);
      return raised;
    }
    return {
      ...f,
      status: "ongoing",
      firstSeenAt: prior.firstSeenAt,
      lastSeenAt: now,
      scanCount: prior.scanCount + 1,
      acknowledgedAt: prior.acknowledgedAt,
      // Keep the prose from when it was first written; re-narrating an ongoing
      // finding every scan burns tokens to say the same thing.
      narrative: prior.narrative ?? f.narrative,
    };
  });

  for (const prior of previous) {
    if (freshKeys.has(prior.key)) continue;
    if (prior.status === "resolved") continue;
    tracked.push({ ...prior, status: "resolved", lastSeenAt: now });
  }

  tracked.sort(byPriority);
  return { tracked: tracked.slice(0, keep), newlyRaised };
}

/**
 * Ordering for the feed.
 *
 * Tiers first, size second. Acknowledgement and resolution are statements
 * about attention, not about magnitude - once someone has said "seen it", a
 * large acknowledged finding must not keep outranking a small live one, which
 * a weighted score would let it do. Within a tier, business impact decides;
 * p-value never does, because a tiny change measured very precisely is still a
 * tiny change.
 */
function tier(f: TrackedFinding): number {
  if (f.status === "resolved") return 3;
  if (f.acknowledgedAt) return 2;
  return f.kind === "incident" ? 0 : 1;
}

function byPriority(a: TrackedFinding, b: TrackedFinding): number {
  return tier(a) - tier(b) || b.impactUnits - a.impactUnits;
}
