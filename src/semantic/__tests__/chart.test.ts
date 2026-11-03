/**
 * The chart rules, which are the only thing standing between a correct number
 * and a chart that misrepresents it.
 *
 * The property worth pinning is the one the three callers rely on: whatever
 * `suggestChart` picks by default must be something `compatibleCharts` also
 * allows. If those two ever disagree, the picker can silently refuse to show
 * the form the answer arrived in.
 */
import { describe, expect, it } from "vitest";
import {
  CHART_TYPES,
  chartShape,
  compatibleCharts,
  excludedCharts,
  suggestChart,
  applyChartChoice,
  type ChartPoint,
  type ChartSpec,
} from "../chart";
import type { ResultSet, ResultRow } from "../execute";
import type { QueryIntent } from "../intent";
import type { DimensionId } from "../fields";
import type { MetricUnit } from "../metrics";

const INTENT = { limit: 10 } as unknown as QueryIntent;

function row(period: string | null, dims: Record<string, string>, value: number, prior?: number): ResultRow {
  return {
    period,
    dims,
    value,
    formatted: String(value),
    support: {},
    ...(prior === undefined
      ? {}
      : { comparison: { value: prior, formatted: String(prior), delta: value - prior, ratio: value / prior } }),
  } as ResultRow;
}

function result(opts: {
  unit: MetricUnit;
  grain: ResultSet["grain"];
  dimensions: DimensionId[];
  rows: ResultRow[];
  limit?: number;
}): ResultSet {
  return {
    intent: { ...INTENT, limit: opts.limit ?? 10 },
    metric: { id: "m", label: "Metric", unit: opts.unit, higherIsBetter: true },
    grain: opts.grain,
    dimensions: opts.dimensions,
    range: { from: "2026-01-01", to: "2026-03-31" },
    comparisonRange: null,
    rows: opts.rows,
    total: null,
    meta: { queries: [], ms: 1, rowCount: opts.rows.length, truncated: false, notes: [] },
  } as unknown as ResultSet;
}

/** A spec's points, in the shape the browser will hand back to the rules. */
function pointsOf(r: ResultSet): ChartPoint[] {
  return r.rows.map((x) => ({
    period: x.period,
    dims: x.dims,
    value: x.value,
    comparison: x.comparison?.value ?? null,
  }));
}

const CHANNELS = ["Organic Search", "Olark Chat", "Reference", "Direct Traffic", "Welcome Page"];
const WEEKS = ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26"];

/** The shapes a question to this dataset can actually produce. */
const CASES: { name: string; result: ResultSet }[] = [
  {
    name: "one number",
    result: result({ unit: "count", grain: "total", dimensions: [], rows: [row(null, {}, 1200)] }),
  },
  {
    name: "counts by channel",
    result: result({
      unit: "count",
      grain: "total",
      dimensions: ["lead_source"],
      rows: CHANNELS.map((c, i) => row(null, { lead_source: c }, 400 - i * 60)),
    }),
  },
  {
    name: "rate by channel",
    result: result({
      unit: "rate",
      grain: "total",
      dimensions: ["lead_source"],
      rows: CHANNELS.map((c, i) => row(null, { lead_source: c }, 0.3 - i * 0.03)),
    }),
  },
  {
    name: "stages",
    result: result({
      unit: "count",
      grain: "total",
      dimensions: ["stage"],
      rows: ["New", "Attempting", "Engaged", "Qualified", "Won"].map((s, i) => row(null, { stage: s }, 900 - i * 150)),
    }),
  },
  {
    name: "counts by week",
    result: result({
      unit: "count",
      grain: "week",
      dimensions: [],
      rows: WEEKS.map((w, i) => row(w, {}, 120 + i * 5)),
    }),
  },
  {
    name: "rate by week",
    result: result({
      unit: "rate",
      grain: "week",
      dimensions: [],
      rows: WEEKS.map((w, i) => row(w, {}, 0.22 - i * 0.02)),
    }),
  },
  {
    name: "counts by week and channel",
    result: result({
      unit: "count",
      grain: "week",
      dimensions: ["lead_source"],
      limit: 5,
      rows: WEEKS.flatMap((w) => CHANNELS.map((c, i) => row(w, { lead_source: c }, 40 - i * 6))),
    }),
  },
  {
    name: "rate by week and channel",
    result: result({
      unit: "rate",
      grain: "week",
      dimensions: ["lead_source"],
      rows: WEEKS.flatMap((w) => CHANNELS.map((c, i) => row(w, { lead_source: c }, 0.2 - i * 0.02))),
    }),
  },
  {
    name: "two dimensions",
    result: result({
      unit: "count",
      grain: "total",
      dimensions: ["lead_source", "city"],
      rows: CHANNELS.flatMap((c) => ["Mumbai", "Pune"].map((city, i) => row(null, { lead_source: c, city }, 30 + i))),
    }),
  },
];

describe("suggestChart", () => {
  it.each(CASES)("$name: the default is a form the rules allow", ({ result: r }) => {
    const spec = suggestChart(r);
    expect(compatibleCharts(spec, pointsOf(r))).toContain(spec.type);
  });

  it("does not put every answer in the same chart", () => {
    const chosen = new Set(CASES.map((c) => suggestChart(c.result).type));
    // The complaint that started this: one shape of answer, one shape of chart.
    expect(chosen.size).toBeGreaterThanOrEqual(4);
  });

  it("gives a stage breakdown a funnel", () => {
    expect(suggestChart(CASES[3]!.result).type).toBe("funnel");
  });

  it("gives counts over time columns and rates over time a line", () => {
    expect(suggestChart(CASES[4]!.result).type).toBe("column");
    expect(suggestChart(CASES[5]!.result).type).toBe("line");
  });
});

describe("compatibleCharts", () => {
  const allowedFor = (name: string) => {
    const c = CASES.find((x) => x.name === name)!;
    return compatibleCharts(suggestChart(c.result), pointsOf(c.result));
  };

  it("never stacks a rate", () => {
    const allowed = allowedFor("rate by week and channel");
    expect(allowed).not.toContain("stacked_bar");
    expect(allowed).not.toContain("stacked_area");
  });

  it("stacks counts over time", () => {
    expect(allowedFor("counts by week and channel")).toContain("stacked_bar");
  });

  it("offers part-to-whole only for additive, non-negative measures", () => {
    expect(allowedFor("counts by channel")).toEqual(expect.arrayContaining(["pie", "donut", "treemap"]));
    const rates = allowedFor("rate by channel");
    expect(rates).not.toContain("pie");
    expect(rates).not.toContain("donut");
  });

  it("keeps part-to-whole available past eight categories, because the tail folds", () => {
    const many = result({
      unit: "count",
      grain: "total",
      dimensions: ["lead_source"],
      rows: Array.from({ length: 12 }, (_, i) => row(null, { lead_source: `c${i}` }, 100 - i)),
    });
    const allowed = compatibleCharts(suggestChart(many), pointsOf(many));
    // Twelve categories are drawn as seven slices and one "Other (5)". Refusing
    // the form would be withholding a correct chart over a solved problem.
    expect(allowed).toEqual(expect.arrayContaining(["pie", "donut", "treemap"]));
  });

  it("offers part-to-whole over a time axis, where the whole is the window", () => {
    const allowed = allowedFor("counts by week and channel");
    expect(allowed).toEqual(expect.arrayContaining(["pie", "donut", "treemap", "bar"]));
  });

  it("does not total a rate over a time axis", () => {
    const allowed = allowedFor("rate by week and channel");
    for (const t of ["pie", "donut", "treemap", "bar"]) expect(allowed).not.toContain(t);
  });

  it("offers a scatter only when there is a prior window to plot against", () => {
    const rows = CHANNELS.map((c, i) => row(null, { lead_source: c }, 100 - i * 10, 90 - i * 10));
    const withPrior = result({ unit: "count", grain: "total", dimensions: ["lead_source"], rows });
    expect(compatibleCharts(suggestChart(withPrior), pointsOf(withPrior))).toContain("scatter");
    expect(allowedFor("counts by channel")).not.toContain("scatter");
  });

  it("always leaves the table available", () => {
    for (const c of CASES) {
      expect(compatibleCharts(suggestChart(c.result), pointsOf(c.result))).toContain("table");
    }
  });

  it("only ever names types the union declares", () => {
    for (const c of CASES) {
      for (const t of compatibleCharts(suggestChart(c.result), pointsOf(c.result))) {
        expect(CHART_TYPES).toContain(t);
      }
    }
  });
});

describe("excludedCharts", () => {
  it("accounts for every form in the union, exactly once", () => {
    for (const c of CASES) {
      const spec = suggestChart(c.result);
      const points = pointsOf(c.result);
      const allowed = compatibleCharts(spec, points);
      const excluded = excludedCharts(spec, points);
      expect([...allowed, ...excluded.map((e) => e.type)].sort()).toEqual([...CHART_TYPES].sort());
    }
  });

  it("gives a reason for each one", () => {
    for (const c of CASES) {
      for (const e of excludedCharts(suggestChart(c.result), pointsOf(c.result))) {
        expect(e.reason.length).toBeGreaterThan(12);
        expect(e.reason).not.toBe("not available for this result");
      }
    }
  });

  it("says why a rate cannot be a pie", () => {
    const c = CASES.find((x) => x.name === "rate by channel")!;
    const excluded = excludedCharts(suggestChart(c.result), pointsOf(c.result));
    expect(excluded.find((e) => e.type === "pie")?.reason).toMatch(/do not add up/);
  });
});

describe("applyChartChoice", () => {
  const c = CASES.find((x) => x.name === "rate by week and channel")!;
  const spec = suggestChart(c.result);
  const allowed = compatibleCharts(spec, pointsOf(c.result));

  it("takes a choice from the allowed list", () => {
    expect(applyChartChoice(spec, "timeline", allowed).type).toBe("timeline");
  });

  it("ignores a choice that would misrepresent the data", () => {
    // The narrator is not permitted to stack a rate by asking nicely.
    expect(applyChartChoice(spec, "stacked_bar", allowed).type).toBe(spec.type);
  });

  it("ignores a type that does not exist", () => {
    expect(applyChartChoice(spec, "sunburst", allowed).type).toBe(spec.type);
  });
});

describe("chartShape", () => {
  it("counts categories on the x dimension when there is no time axis", () => {
    const c = CASES.find((x) => x.name === "counts by channel")!;
    const spec: ChartSpec = suggestChart(c.result);
    expect(chartShape(spec, pointsOf(c.result)).categories).toBe(CHANNELS.length);
  });

  it("counts series when there is", () => {
    const c = CASES.find((x) => x.name === "counts by week and channel")!;
    const shape = chartShape(suggestChart(c.result), pointsOf(c.result));
    expect(shape.periods).toBe(WEEKS.length);
    expect(shape.seriesCount).toBe(CHANNELS.length);
  });
});
