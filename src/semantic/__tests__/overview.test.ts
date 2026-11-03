/**
 * The overview's two decisions that can be silently wrong.
 *
 * Which metrics it runs is a list, and a reader can check a list. Which
 * *window* the outcome metrics describe is arithmetic, and getting it wrong
 * produces a number that looks completely ordinary and is not true - a
 * conversion rate for a cohort that has not finished converting.
 */
import { describe, expect, it } from "vitest";
import {
  OVERVIEW_LIVE,
  OVERVIEW_MATURED,
  overviewSummary,
  overviewWindows,
  type OverviewResult,
  type OverviewTile,
} from "../overview";
import { validateOverview, IntentError } from "../intent";
import { MATURATION_DAYS, METRICS } from "../metrics";

const TODAY = "2026-09-24";

describe("overviewWindows", () => {
  it("lags the outcome window when the question is about a window too recent to have converted", () => {
    const { maturedPeriod, lagged } = overviewWindows({ from: "2026-09-23", to: "2026-09-23" }, TODAY);
    expect(lagged).toBe(true);
    // A single day, MATURATION_DAYS back from today, not from the day asked about.
    expect(maturedPeriod).toEqual({ from: "2026-09-03", to: "2026-09-03" });
  });

  it("keeps the same length as the window that was asked for", () => {
    const { maturedPeriod } = overviewWindows({ from: "2026-09-18", to: "2026-09-24" }, TODAY);
    const days = (Date.parse(maturedPeriod.to) - Date.parse(maturedPeriod.from)) / 86_400_000 + 1;
    expect(days).toBe(7);
  });

  it("leaves a window that has already matured exactly where it is", () => {
    const period = { from: "2026-06-01", to: "2026-06-30" };
    expect(overviewWindows(period, TODAY)).toEqual({ maturedPeriod: period, lagged: false });
  });

  it("treats the boundary day as mature", () => {
    const to = "2026-09-03";
    expect(Date.parse(TODAY) - Date.parse(to)).toBe(MATURATION_DAYS * 86_400_000);
    expect(overviewWindows({ from: to, to }, TODAY).lagged).toBe(false);
  });
});

describe("the metric blocks", () => {
  it("only names metrics that exist", () => {
    for (const id of [...OVERVIEW_LIVE, ...OVERVIEW_MATURED]) expect(METRICS[id]).toBeDefined();
  });

  it("puts every outcome metric in the matured block, and none in the live one", () => {
    // The live block is what is knowable the moment the window closes. A metric
    // that depends on a lead having converted is not.
    expect(OVERVIEW_MATURED).toContain("conversion_rate_21d");
    expect(OVERVIEW_MATURED).toContain("cac");
    for (const id of OVERVIEW_LIVE) expect(OVERVIEW_MATURED).not.toContain(id);
  });

  it("does not report a raw conversion rate anywhere", () => {
    // `conversion_rate` counts every conversion whenever it happened, so on a
    // recent window it is a different kind of wrong from the one the lag fixes.
    const all = [...OVERVIEW_LIVE, ...OVERVIEW_MATURED];
    expect(all).not.toContain("conversion_rate");
  });
});

describe("validateOverview", () => {
  const valid = { dateRange: { from: "2026-09-01", to: "2026-09-24" }, filters: [] };

  it("accepts a window", () => {
    expect(validateOverview(valid).dateRange.to).toBe("2026-09-24");
  });

  it("rejects a backwards range", () => {
    expect(() => validateOverview({ ...valid, dateRange: { from: "2026-09-24", to: "2026-09-01" } })).toThrow(
      IntentError,
    );
  });

  it("rejects an operator the field cannot take", () => {
    expect(() =>
      validateOverview({ ...valid, filters: [{ field: "lead_source", op: "gt", values: ["Google"] }] }),
    ).toThrow(IntentError);
  });

  it("rejects a filter with no value", () => {
    expect(() =>
      validateOverview({ ...valid, filters: [{ field: "lead_source", op: "eq", values: [] }] }),
    ).toThrow(IntentError);
  });

  it("rejects a filter set that no single metric could carry", () => {
    // The failure this came from: a planner padded `filters` with an
    // `is_not_null` on every field it could name, including a spend field. Each
    // metric then failed validation on its own and the overview came back with
    // no numbers at all, which reads as a working answer.
    expect(() =>
      validateOverview({
        ...valid,
        filters: [
          { field: "lead_source", op: "is_not_null", values: [] },
          { field: "channel", op: "is_not_null", values: [] },
        ],
      }),
    ).toThrow(/mix lead fields with channel_spend/);
  });

  it("allows a filter set drawn from one collection", () => {
    expect(
      validateOverview({
        ...valid,
        filters: [{ field: "lead_source", op: "eq", values: ["Google"] }],
      }).filters,
    ).toHaveLength(1);
  });

  it("has nothing to guess at: no metric, and no choice about comparing", () => {
    const out = validateOverview({ ...valid, metric: "leads_created", compareTo: "none" });
    expect(out).not.toHaveProperty("metric");
    expect(out).not.toHaveProperty("compareTo");
  });
});

function tile(over: Partial<OverviewTile> = {}): OverviewTile {
  return {
    id: "leads_created",
    label: "Leads created",
    description: "",
    formatted: "120",
    priorFormatted: "100",
    changePct: 20,
    higherIsBetter: true,
    ...over,
  };
}

function result(over: Partial<OverviewResult> = {}): OverviewResult {
  return {
    intent: { dateRange: { from: "2026-09-23", to: "2026-09-23" }, filters: [] },
    period: { from: "2026-09-23", to: "2026-09-23" },
    priorPeriod: { from: "2026-09-22", to: "2026-09-22" },
    live: [tile()],
    matured: [],
    maturedPeriod: { from: "2026-09-03", to: "2026-09-03" },
    maturedIsLagged: true,
    queries: [],
    notes: [],
    ms: 1,
    ...over,
  };
}

describe("overviewSummary", () => {
  it("leads with the volume and the window", () => {
    expect(overviewSummary(result()).headline).toBe("120 leads, 2026-09-23");
  });

  it("says once that every move went the wrong way, rather than three times", () => {
    const r = result({
      live: [
        tile({ changePct: -29 }),
        tile({ id: "cpl", label: "Cost per lead", changePct: 30, higherIsBetter: false, formatted: "₹412" }),
      ],
    });
    const { narrative } = overviewSummary(r);
    expect(narrative).toContain("all the wrong way");
    expect(narrative).not.toContain("(the wrong way)");
  });

  it("names a move against the wrong direction as such", () => {
    const r = result({
      live: [tile(), tile({ id: "cpl", label: "Cost per lead", changePct: 30, higherIsBetter: false, formatted: "₹412" })],
    });
    expect(overviewSummary(r).narrative).toContain("Cost per lead up 30% (the wrong way) at ₹412");
  });

  it("does not dress a rounding error as a movement", () => {
    const r = result({ live: [tile({ changePct: 0.4 })] });
    expect(overviewSummary(r).narrative).toContain("Nothing moved more than 5%");
  });

  it("says which window the outcome tiles describe", () => {
    const r = result({ matured: [tile({ id: "cac", label: "CAC" })] });
    expect(overviewSummary(r).narrative).toContain("2026-09-03");
  });

  it("says so plainly when a delta could not be computed at all", () => {
    const r = result({ live: [tile({ changePct: null })], maturedIsLagged: false });
    expect(overviewSummary(r).narrative).toContain("Nothing moved more than 5%");
  });
});
