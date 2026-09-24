/**
 * The metric registry: every number this system can produce, defined once.
 *
 * A metric owns its numerator, its denominator and its null semantics. That
 * matters more than it sounds - "conversion rate" is ambiguous in English and
 * exact here, and two different parts of the app can never disagree about it.
 *
 * ## Cohort convention
 * Every `leads`-sourced metric buckets by **`created_at`**, not `converted_at`.
 * A lead created in June that converts in August counts in June. This makes
 * conversion rate a property of an acquisition cohort, which is the only
 * reading under which "conversion by channel" compares like with like - and it
 * is what makes the planted Olark collapse visible in the week it happened.
 * The cost is that recent buckets are still maturing; the narrator is told to
 * say so.
 */
import type { Document } from "mongodb";

export type MetricUnit = "count" | "rate" | "currency_inr" | "days" | "touches";

/** Which physical query shape the compiler has to emit. */
export type MetricEngine = "leads" | "spend" | "cac" | "touches";

export interface MetricDef {
  id: string;
  label: string;
  unit: MetricUnit;
  engine: MetricEngine;
  /** Shown to the intent generator. Written for a reader who will misuse it. */
  description: string;
  /** Extra `$match` merged into the base filter - part of the definition, not a user filter. */
  prefilter?: Document;
  /** `$group` accumulators. Keys become row support columns. */
  accumulators: Document;
  /** Final value from one grouped row. `null` means "not defined here", not zero. */
  compute: (g: Record<string, number | null | undefined>) => number | null;
  /** Support columns surfaced next to the value, in display order. */
  support: readonly string[];
  /** Used for phrasing deltas ("improved" vs "worsened") and chart colouring. */
  higherIsBetter: boolean;
  /** Dimensions this metric cannot be split by, with the reason. */
  incompatibleDimensions?: Readonly<Record<string, string>>;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const ratio = (a: number | null, b: number | null): number | null =>
  a === null || b === null || b === 0 ? null : a / b;

/** Count of docs where a boolean-ish path is true. */
const countWhereTrue = (path: string): Document => ({
  $sum: { $cond: [{ $eq: [`$${path}`, true] }, 1, 0] },
});

/** Count of docs where a path holds an actual boolean (not null/missing). */
const countWhereBoolean = (path: string): Document => ({
  $sum: { $cond: [{ $eq: [{ $type: `$${path}` }, "bool"] }, 1, 0] },
});

const SPEND_ONLY_DIMENSIONS: Readonly<Record<string, string>> = {
  lead_origin: "spend is recorded per channel, not per origin",
  stage: "spend is recorded per channel per day, not per lead",
  owner_id: "spend is not attributed to a rep",
  city: "spend is not attributed to a city",
  country: "spend is not attributed to a country",
  specialization: "spend is not attributed to a specialisation",
  occupation: "spend is not attributed to an occupation",
  primary_motivation: "spend is not attributed to a motivation",
  heard_from: "spend is not attributed to self-reported attribution",
  last_activity: "spend is not attributed to an activity",
  is_open: "spend is not attributed per lead",
  converted: "spend is not attributed per lead",
  sla_breached: "spend is not attributed per lead",
};

export const METRICS = {
  leads_created: {
    id: "leads_created",
    label: "Leads created",
    unit: "count",
    engine: "leads",
    description: "How many leads were created in the period.",
    accumulators: { n: { $sum: 1 } },
    compute: (g) => num(g.n) ?? 0,
    support: ["n"],
    higherIsBetter: true,
  },

  leads_converted: {
    id: "leads_converted",
    label: "Conversions",
    unit: "count",
    engine: "leads",
    description:
      "How many leads created in the period went on to convert, counted in their creation period whenever the conversion landed.",
    accumulators: { n: { $sum: 1 }, won: countWhereTrue("converted") },
    compute: (g) => num(g.won) ?? 0,
    support: ["won", "n"],
    higherIsBetter: true,
  },

  conversion_rate: {
    id: "conversion_rate",
    label: "Conversion rate",
    unit: "rate",
    engine: "leads",
    description:
      "Share of leads created in the period that converted. An empty bucket is null, not 0%.",
    accumulators: { n: { $sum: 1 }, won: countWhereTrue("converted") },
    compute: (g) => ratio(num(g.won), num(g.n)),
    support: ["won", "n"],
    higherIsBetter: true,
  },

  avg_days_to_convert: {
    id: "avg_days_to_convert",
    label: "Average days to convert",
    unit: "days",
    engine: "leads",
    description:
      "Mean days from creation to conversion, over converted leads only. Survivor-biased in recent periods: slow conversions have not landed yet.",
    prefilter: { converted: true },
    accumulators: { won: { $sum: 1 }, days: { $avg: "$days_to_convert" } },
    compute: (g) => num(g.days),
    support: ["won"],
    higherIsBetter: false,
  },

  sla_breach_rate: {
    id: "sla_breach_rate",
    label: "SLA breach rate",
    unit: "rate",
    engine: "leads",
    description:
      "Share of leads whose first response missed the SLA. The denominator counts only leads with a recorded first response.",
    accumulators: {
      n: { $sum: 1 },
      breached: countWhereTrue("sla.breached"),
      measured: countWhereBoolean("sla.breached"),
    },
    compute: (g) => ratio(num(g.breached), num(g.measured)),
    support: ["breached", "measured", "n"],
    higherIsBetter: false,
  },

  open_pipeline: {
    id: "open_pipeline",
    label: "Open leads",
    unit: "count",
    engine: "leads",
    description:
      "Leads created in the period that are still open - not Won, Lost, Unreachable or Disqualified. A snapshot of the state today, sliced by when the lead arrived.",
    accumulators: { n: { $sum: 1 }, open: countWhereTrue("is_open") },
    compute: (g) => num(g.open) ?? 0,
    support: ["open", "n"],
    higherIsBetter: true,
  },

  touches_to_convert: {
    id: "touches_to_convert",
    label: "Touches to convert",
    unit: "touches",
    engine: "touches",
    description:
      "Mean number of logged activities on a converted lead - how much work a win costs.",
    prefilter: { converted: true },
    accumulators: { won: { $sum: 1 }, touches: { $avg: "$touch_count" } },
    compute: (g) => num(g.touches),
    support: ["won"],
    higherIsBetter: false,
  },

  cpl: {
    id: "cpl",
    label: "Cost per lead",
    unit: "currency_inr",
    engine: "spend",
    description:
      "Media spend divided by attributed leads, from channel_spend. Paid channels only - Google, Facebook, Bing, Other. Free traffic has no CPL, which is not the same as a CPL of zero.",
    accumulators: { spend: { $sum: "$spend_inr" }, leads: { $sum: "$leads" } },
    compute: (g) => ratio(num(g.spend), num(g.leads)),
    support: ["spend", "leads"],
    higherIsBetter: false,
    incompatibleDimensions: SPEND_ONLY_DIMENSIONS,
  },

  cac: {
    id: "cac",
    label: "Customer acquisition cost",
    unit: "currency_inr",
    engine: "cac",
    description:
      "Media spend divided by the conversions it bought. Paid channels only. Spend is matched to the creation period of the leads, so a period still waiting on conversions reads high.",
    accumulators: {},
    compute: (g) => ratio(num(g.spend), num(g.won)),
    support: ["spend", "won", "n"],
    higherIsBetter: false,
    incompatibleDimensions: SPEND_ONLY_DIMENSIONS,
  },
} as const satisfies Record<string, MetricDef>;

export type MetricId = keyof typeof METRICS;
export const METRIC_IDS = Object.keys(METRICS) as MetricId[];

export function metric(id: MetricId): MetricDef {
  return METRICS[id];
}

/** Spend-sourced metrics can only be split by paid channel. */
export function isSpendSourced(m: MetricDef): boolean {
  return m.engine === "spend" || m.engine === "cac";
}

export function formatValue(v: number | null, unit: MetricUnit): string {
  if (v === null) return "n/a";
  switch (unit) {
    case "rate":
      return `${(v * 100).toFixed(1)}%`;
    case "currency_inr":
      return `₹${Math.round(v).toLocaleString("en-IN")}`;
    case "days":
      return `${v.toFixed(1)} days`;
    case "touches":
      return v.toFixed(1);
    default:
      return Math.round(v).toLocaleString("en-IN");
  }
}
