/**
 * Chart specs, not charts.
 *
 * The tool returns a typed description of what to draw and React draws it.
 * Never an image, never HTML, never a chart library call authored by a model -
 * a spec can be validated, diffed in an eval, and re-themed; a blob of SVG can
 * do none of those things.
 *
 * There is one rule set here, `compatibleCharts`, and three callers use it:
 * `suggestChart` picks a default out of it, the narrator may swap to any other
 * member of it, and the chart picker in the UI offers exactly it. A form that
 * is wrong for the data is therefore unreachable from every direction, and a
 * form that is right is reachable from all three.
 */
import type { DimensionId } from "./fields";
import { FUNNEL_STAGES } from "./fields";
import type { ResultSet } from "./execute";
import type { MetricUnit } from "./metrics";

export const CHART_TYPES = [
  "line",
  "area",
  "stacked_area",
  "column",
  "bar",
  "grouped_bar",
  "stacked_bar",
  "pie",
  "donut",
  "treemap",
  "funnel",
  "timeline",
  "heatmap",
  "scatter",
  "table",
] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const CHART_LABELS: Record<ChartType, string> = {
  line: "Line",
  area: "Area",
  stacked_area: "Stacked area",
  column: "Columns",
  bar: "Bars",
  grouped_bar: "Grouped bars",
  stacked_bar: "Stacked bars",
  pie: "Pie",
  donut: "Donut",
  treemap: "Treemap",
  funnel: "Funnel",
  timeline: "Timeline",
  heatmap: "Heatmap",
  scatter: "Scatter",
  table: "Table only",
};

/**
 * How many categorical slots the palette has before the tail folds into one
 * grey "Other". The rules need it as well as the renderer: it is the reason a
 * part-to-whole form has no upper limit on categories.
 */
export const SERIES_SLOTS = 8;

export interface ChartAnnotation {
  /** `YYYY-MM-DD` on the x axis, or a category label when x is categorical. */
  at: string;
  note: string;
}

export interface ChartSpec {
  type: ChartType;
  /** Field driving the x axis: a grain name, or a dimension id. */
  x: string;
  /** Dimension ids that split the data into series. Empty means one series. */
  series: DimensionId[];
  /** Metric id plotted on y. */
  y: string;
  yUnit: MetricUnit;
  title: string;
  /** Rendering hint: `true` when lower values are the good ones. */
  invertGood: boolean;
  annotations: ChartAnnotation[];
}

/**
 * The minimum a point needs for the rules below to hold.
 *
 * Structural on purpose: `AnswerPoint` in the agent satisfies it, so the same
 * function runs on the server to constrain the narrator and in the browser to
 * build the picker, with no import cycle between them.
 */
export interface ChartPoint {
  period: string | null;
  dims: Record<string, string>;
  value: number | null;
  comparison: number | null;
}

/** A unit that can be added up. Rates and averages can be neither stacked nor pooled. */
function isAdditive(unit: MetricUnit): boolean {
  return unit === "count" || unit === "currency_inr";
}

export interface ChartShape {
  periods: number;
  seriesCount: number;
  /** Distinct marks along the categorical axis, when there is one. */
  categories: number;
  additive: boolean;
  hasComparison: boolean;
  allNonNegative: boolean;
  funnelShaped: boolean;
}

export function chartShape(spec: ChartSpec, points: ChartPoint[]): ChartShape {
  const periods = new Set(points.map((p) => p.period).filter((p): p is string => p !== null));
  const seriesKey = (p: ChartPoint) =>
    spec.series.length === 0 ? "" : spec.series.map((d) => p.dims[d] ?? "-").join(" / ");
  const seriesCount = new Set(points.map(seriesKey)).size;
  const categories =
    periods.size > 0 ? seriesCount : new Set(points.map((p) => p.dims[spec.x] ?? seriesKey(p))).size;
  const stages = new Set(points.map((p) => p.dims.stage));

  return {
    periods: periods.size,
    seriesCount,
    categories,
    additive: isAdditive(spec.yUnit),
    hasComparison: points.some((p) => p.comparison !== null),
    allNonNegative: points.every((p) => (p.value ?? 0) >= 0),
    funnelShaped: FUNNEL_STAGES.filter((s) => stages.has(s)).length >= 3,
  };
}

/**
 * Every chart form this result can carry without lying.
 *
 * The exclusions are correctness, not taste: a stacked rate totals to a number
 * that does not exist, overlapping filled areas hide each other, a line over
 * unordered categories invents an order, and a part-to-whole of a measure that
 * does not add up has no whole. Being hard to read is *not* on that list -
 * twelve categories are folded to eight, not refused. Taste - which of the
 * legal forms is best - is `suggestChart`'s job, and the reader overrules it.
 */
export function compatibleCharts(spec: ChartSpec, points: ChartPoint[]): ChartType[] {
  const s = chartShape(spec, points);
  const out: ChartType[] = [];
  const add = (t: ChartType, when: boolean) => {
    if (when) out.push(t);
  };

  /*
   * A whole worth taking parts of: the measure adds up, and nothing is
   * negative. There is no cap on how many parts - the renderer folds
   * everything past `SERIES_SLOTS` into one "Other (n)", so a pie of twelve
   * categories is drawn as eight slices, not twelve unreadable ones.
   *
   * Over a time axis the whole is the window: the parts are the series (or the
   * periods, when there are none), totalled. That is a different question from
   * the one the line chart answers, not a worse version of it.
   */
  const partToWhole = s.additive && s.allNonNegative && (s.periods > 0 ? s.seriesCount : s.categories) >= 2;

  if (s.periods > 0) {
    add("line", true);
    add("timeline", true);
    add("area", s.seriesCount <= 1);
    add("column", s.seriesCount <= 1);
    add("grouped_bar", s.seriesCount >= 2 && s.seriesCount <= 4 && s.periods <= 10);
    add("stacked_bar", s.seriesCount >= 2 && s.additive);
    add("stacked_area", s.seriesCount >= 2 && s.additive);
    add("heatmap", s.seriesCount >= 2);
    add("scatter", s.hasComparison && s.periods >= 3);
    // Ranked bars over a time axis mean totals, so they need the same measure
    // that makes a total meaningful.
    add("bar", s.seriesCount <= 1 ? s.periods <= 24 : s.additive && s.allNonNegative);
    add("pie", partToWhole);
    add("donut", partToWhole);
    add("treemap", partToWhole);
  } else {
    add("bar", true);
    add("column", s.categories <= 10);
    add("funnel", s.funnelShaped);
    add("pie", partToWhole);
    add("donut", partToWhole);
    add("treemap", partToWhole);
    add("heatmap", spec.series.length >= 1);
    add("scatter", s.hasComparison && s.categories >= 3);
  }

  add("table", true);
  return out;
}

/**
 * Why the rest are missing.
 *
 * A form that is absent with no explanation reads as a form that is broken.
 * These reasons are written here, beside the rule that excluded it, so the two
 * cannot drift apart - and the UI prints them under the picker.
 */
export function excludedCharts(spec: ChartSpec, points: ChartPoint[]): { type: ChartType; reason: string }[] {
  const s = chartShape(spec, points);
  const allowed = new Set(compatibleCharts(spec, points));
  const timed = s.periods > 0;
  const noWhole = !s.additive
    ? "rates and averages do not add up, so there is no whole to take parts of"
    : "some values are negative, so the parts do not make a whole";

  const reason = (t: ChartType): string => {
    switch (t) {
      case "line":
      case "area":
      case "stacked_area":
        if (!timed) return "needs a time axis - joining unordered categories with a line invents an order";
        if (t === "area") return "more than one series - overlapping fills hide each other; use stacked area";
        return "a stacked rate totals to a number that does not exist";
      case "column":
        return timed ? "more than one series - use grouped or stacked bars" : "too many categories to label";
      case "bar":
        return "ranking over time means totalling, and this measure does not total";
      case "grouped_bar":
        return timed
          ? "only reads at two to four series over at most ten periods"
          : "needs a time axis and a second dimension";
      case "stacked_bar":
        return timed ? "a stacked rate totals to a number that does not exist" : "needs a time axis";
      case "pie":
      case "donut":
      case "treemap":
        return s.additive && s.allNonNegative ? "needs at least two parts" : noWhole;
      case "funnel":
        return "only for a breakdown over the pipeline stages";
      case "timeline":
        return "needs a time axis";
      case "heatmap":
        return "needs two axes - a second dimension, or time and a dimension";
      case "scatter":
        return "needs a comparison window - try asking for this month against last month";
      default:
        return "not available for this result";
    }
  };

  return CHART_TYPES.filter((t) => !allowed.has(t)).map((t) => ({ type: t, reason: reason(t) }));
}

/**
 * Pick the chart the data actually supports.
 *
 * The rules are boring on purpose - a reader should be able to predict the
 * output from the question - and every branch returns something
 * `compatibleCharts` also allows, which the unit test asserts rather than
 * trusts.
 */
export function suggestChart(result: ResultSet): ChartSpec {
  const { grain, dimensions, metric, intent } = result;
  const base = {
    y: metric.id,
    yUnit: metric.unit,
    invertGood: !metric.higherIsBetter,
    annotations: [] as ChartAnnotation[],
    title: chartTitle(result),
  };
  const additive = isAdditive(metric.unit);

  // A stage breakdown over the canonical pipeline order is a funnel, whatever
  // else is true about it.
  if (grain === "total" && dimensions.length === 1 && dimensions[0] === "stage" && isFunnelShaped(result)) {
    return { ...base, type: "funnel", x: "stage", series: [] };
  }

  if (grain === "total") {
    if (dimensions.length === 0) return { ...base, type: "bar", x: "total", series: [] };
    if (dimensions.length === 1) {
      const categories = new Set(result.rows.map((r) => r.dims[dimensions[0] as string])).size;
      const positive = result.rows.every((r) => (r.value ?? 0) >= 0);
      // A genuine part-to-whole with few enough slices to read. Past five, arc
      // lengths stop being comparable to each other and it goes back to bars.
      const type: ChartType = additive && positive && categories >= 2 && categories <= 5 ? "donut" : "bar";
      return { ...base, type, x: dimensions[0] as string, series: [] };
    }
    // Two categorical axes and one number is a heatmap; a grouped bar with
    // this many cells is unreadable.
    return { ...base, type: "heatmap", x: dimensions[0] as string, series: [dimensions[1] as DimensionId] };
  }

  // Time series.
  if (dimensions.length === 0) {
    const periods = new Set(result.rows.map((r) => r.period)).size;
    // A count happened *inside* a bucket, which is what a column says. A rate
    // is a level that carries between buckets, which is what a line says.
    return { ...base, type: additive && periods <= 16 ? "column" : "line", x: grain, series: [] };
  }
  if (dimensions.length === 1) {
    return {
      ...base,
      // Counts and money stack meaningfully; rates and averages never do.
      type: additive && intent.limit <= 6 ? "stacked_bar" : "line",
      x: grain,
      series: [dimensions[0] as DimensionId],
    };
  }
  return { ...base, type: "line", x: grain, series: [...dimensions] };
}

/** Apply a narrator's chart-type choice, ignoring it when it is not allowed. */
export function applyChartChoice(
  spec: ChartSpec,
  choice: string | undefined,
  allowed: ChartType[],
): ChartSpec {
  if (!choice) return spec;
  return allowed.includes(choice as ChartType) ? { ...spec, type: choice as ChartType } : spec;
}

function isFunnelShaped(result: ResultSet): boolean {
  const labels = new Set(result.rows.map((r) => r.dims.stage));
  return FUNNEL_STAGES.filter((s) => labels.has(s)).length >= 3;
}

function chartTitle(result: ResultSet): string {
  const { metric, dimensions, grain, range } = result;
  const by = dimensions.length > 0 ? ` by ${dimensions.join(" and ")}` : "";
  const per = grain === "total" ? "" : ` per ${grain}`;
  return `${metric.label}${by}${per}, ${range.from} to ${range.to}`;
}

/** Annotate a chart with the window of a known incident, when it overlaps. */
export function annotate(spec: ChartSpec, at: string, note: string): ChartSpec {
  return { ...spec, annotations: [...spec.annotations, { at, note }] };
}
