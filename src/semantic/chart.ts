/**
 * Chart specs, not charts.
 *
 * The tool returns a typed description of what to draw and React draws it.
 * Never an image, never HTML, never a chart library call authored by a model -
 * a spec can be validated, diffed in an eval, and re-themed; a blob of SVG can
 * do none of those things.
 *
 * The *type* is chosen deterministically from the shape of the result. The
 * narrator may override it, but only to another member of this union, and only
 * when `chartTypeIsNegotiable` says the choice was a judgement call rather than
 * forced by the data.
 */
import type { DimensionId } from "./fields";
import { FUNNEL_STAGES } from "./fields";
import type { ResultSet } from "./execute";
import type { MetricUnit } from "./metrics";

export const CHART_TYPES = ["line", "bar", "stacked_bar", "funnel", "heatmap", "table"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

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
 * Pick the chart the data actually supports.
 *
 * The rules are boring on purpose - a reader should be able to predict the
 * output from the question.
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

  // A stage breakdown over the canonical pipeline order is a funnel, whatever
  // else is true about it.
  if (grain === "total" && dimensions.length === 1 && dimensions[0] === "stage" && isFunnelShaped(result)) {
    return { ...base, type: "funnel", x: "stage", series: [] };
  }

  if (grain === "total") {
    if (dimensions.length === 0) return { ...base, type: "bar", x: "total", series: [] };
    if (dimensions.length === 1) return { ...base, type: "bar", x: dimensions[0] as string, series: [] };
    // Two categorical axes and one number is a heatmap; a grouped bar with
    // this many cells is unreadable.
    return { ...base, type: "heatmap", x: dimensions[0] as string, series: [dimensions[1] as DimensionId] };
  }

  // Time series. Counts stack meaningfully; rates and averages do not - a
  // stacked conversion rate is a nonsense number.
  if (dimensions.length === 0) return { ...base, type: "line", x: grain, series: [] };
  if (dimensions.length === 1) {
    const stackable = metric.unit === "count" || metric.unit === "currency_inr";
    return {
      ...base,
      type: stackable && intent.limit <= 6 ? "stacked_bar" : "line",
      x: grain,
      series: [dimensions[0] as DimensionId],
    };
  }
  return { ...base, type: "line", x: grain, series: [...dimensions] };
}

/**
 * Whether the narrator is allowed to swap the chart type. It may not turn a
 * two-dimensional result into a line chart or a rate into a stacked bar - those
 * are correctness constraints, not taste.
 */
export function chartTypeIsNegotiable(spec: ChartSpec): ChartType[] {
  switch (spec.type) {
    case "line":
      return spec.series.length <= 1 ? ["line", "bar"] : ["line"];
    case "stacked_bar":
      return ["stacked_bar", "line", "bar"];
    case "bar":
      return ["bar", "table"];
    case "funnel":
      return ["funnel", "bar"];
    default:
      return [spec.type];
  }
}

/** Apply a narrator's chart-type choice, ignoring it when it is not allowed. */
export function applyChartChoice(spec: ChartSpec, choice: string | undefined): ChartSpec {
  if (!choice) return spec;
  const allowed = chartTypeIsNegotiable(spec);
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
