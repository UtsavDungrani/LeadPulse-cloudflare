/**
 * The golden question set for intent accuracy.
 *
 * Analytics needs a different eval axis from a conversational agent. Tone and
 * persona are not the risk here; being confidently wrong about a number is.
 * So there are three things to measure, and this file is the input to the first
 * two:
 *
 *  1. **Intent accuracy** - question -> expected `QueryIntent`, asserted by
 *     exact-matching the *compiled pipeline*. Comparing pipelines rather than
 *     intents means two intents that differ cosmetically but produce identical
 *     queries both pass, which is the behaviour you want.
 *  2. **Refusal correctness** - "what is our LTV?" has no answer in this data.
 *     Saying so is a pass. A plausible-looking number is the failure mode that
 *     actually costs someone money.
 *  3. **Numeric fidelity** - every figure in the narrative must appear in
 *     `allowedFigures(result)`. That one runs off the result set, not off this
 *     file.
 *
 * Dates are frozen to `EVAL_TODAY` so that "last week" means the same thing in
 * March as it does today.
 */
import type { QueryIntent } from "../semantic/intent";

/** Frozen "now" for every case. Matches the end of the data window. */
export const EVAL_TODAY = new Date("2026-09-24T12:00:00.000Z");

export interface GoldenCase {
  id: string;
  question: string;
  /** What the planner should produce, or a refusal. */
  expect: { kind: "query"; intent: QueryIntent } | { kind: "refusal" };
  /** Optional preceding intent, for follow-up cases. */
  previous?: QueryIntent;
  /** Why this case is here, when it is not obvious. */
  note?: string;
}

const q = (intent: QueryIntent): GoldenCase["expect"] => ({ kind: "query", intent });
const refuse: GoldenCase["expect"] = { kind: "refusal" };

export const GOLDEN: GoldenCase[] = [
  // --- plain aggregates -----------------------------------------------------
  {
    id: "leads-last-week",
    question: "How many leads did we get last week?",
    expect: q({
      metric: "leads_created",
      grain: "total",
      dateRange: { from: "2026-09-14", to: "2026-09-20" },
      dimensions: [],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "conversion-this-month",
    question: "What is our conversion rate this month?",
    expect: q({
      metric: "conversion_rate",
      grain: "total",
      dateRange: { from: "2026-09-01", to: "2026-09-24" },
      dimensions: [],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "report-last-week",
    question: "Give me a report for last week.",
    note: "Deliberately vague. Any reasonable reading is a weekly volume read-out.",
    expect: q({
      metric: "leads_created",
      grain: "total",
      dateRange: { from: "2026-09-14", to: "2026-09-20" },
      dimensions: [],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },

  // --- breakdowns -----------------------------------------------------------
  {
    id: "conversion-by-channel-this-month",
    question: "Conversion by channel this month.",
    expect: q({
      metric: "conversion_rate",
      grain: "total",
      dateRange: { from: "2026-09-01", to: "2026-09-24" },
      dimensions: ["lead_source"],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "conversion-by-channel-vs-last-month",
    question: "Conversion by channel this month vs last month.",
    expect: q({
      metric: "conversion_rate",
      grain: "total",
      dateRange: { from: "2026-09-01", to: "2026-09-24" },
      dimensions: ["lead_source"],
      filters: [],
      compareTo: "previous_period",
      limit: 10,
    }),
  },
  {
    id: "leads-by-origin-quarter",
    question: "Break leads down by origin for last quarter.",
    expect: q({
      metric: "leads_created",
      grain: "total",
      dateRange: { from: "2026-04-01", to: "2026-06-30" },
      dimensions: ["lead_origin"],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "pipeline-by-stage",
    question: "What does the pipeline look like by stage right now?",
    expect: q({
      metric: "open_pipeline",
      grain: "total",
      dateRange: { from: "2025-07-24", to: "2026-09-24" },
      dimensions: ["stage"],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },

  // --- time series ----------------------------------------------------------
  {
    id: "weekly-conversion-trend",
    question: "Show me the weekly conversion rate trend over the last 90 days.",
    expect: q({
      metric: "conversion_rate",
      grain: "week",
      dateRange: { from: "2026-06-27", to: "2026-09-24" },
      dimensions: [],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "monthly-leads-by-source",
    question: "Monthly lead volume by source for the last year.",
    expect: q({
      metric: "leads_created",
      grain: "month",
      dateRange: { from: "2025-09-24", to: "2026-09-24" },
      dimensions: ["lead_source"],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "olark-weekly-june",
    question: "Show Olark Chat conversion by week in June 2026.",
    note: "The planted Olark collapse - the single most important query in the set.",
    expect: q({
      metric: "conversion_rate",
      grain: "week",
      dateRange: { from: "2026-06-01", to: "2026-06-30" },
      dimensions: [],
      filters: [{ field: "lead_source", op: "eq", values: ["Olark Chat"] }],
      compareTo: "none",
      limit: 10,
    }),
  },

  // --- filters --------------------------------------------------------------
  {
    id: "working-professionals-conversion",
    question: "How well do working professionals convert this year?",
    expect: q({
      metric: "conversion_rate",
      grain: "total",
      dateRange: { from: "2026-01-01", to: "2026-09-24" },
      dimensions: [],
      filters: [{ field: "occupation", op: "eq", values: ["Working Professional"] }],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "mumbai-vs-rest",
    question: "Leads from Mumbai last month.",
    expect: q({
      metric: "leads_created",
      grain: "total",
      dateRange: { from: "2026-08-01", to: "2026-08-31" },
      dimensions: [],
      filters: [{ field: "city", op: "eq", values: ["Mumbai"] }],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "unknown-city",
    question: "How many leads last month have no city recorded?",
    note: "Exercises is_null; the profile fields are 20-55% unknown.",
    expect: q({
      metric: "leads_created",
      grain: "total",
      dateRange: { from: "2026-08-01", to: "2026-08-31" },
      dimensions: [],
      filters: [{ field: "city", op: "is_null", values: [] }],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "paid-channels-only",
    question: "Conversion rate for Google and Facebook leads this quarter.",
    expect: q({
      metric: "conversion_rate",
      grain: "total",
      dateRange: { from: "2026-07-01", to: "2026-09-24" },
      dimensions: ["lead_source"],
      filters: [{ field: "lead_source", op: "in", values: ["Google", "Facebook"] }],
      compareTo: "none",
      limit: 10,
    }),
  },

  // --- rep performance ------------------------------------------------------
  {
    id: "stale-leads-by-rep",
    question: "Which rep is sitting on the most stale leads?",
    expect: q({
      metric: "open_pipeline",
      grain: "total",
      dateRange: { from: "2025-07-24", to: "2026-09-24" },
      dimensions: ["owner_id"],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "sla-by-rep",
    question: "Who is breaching SLA the most this quarter?",
    expect: q({
      metric: "sla_breach_rate",
      grain: "total",
      dateRange: { from: "2026-07-01", to: "2026-09-24" },
      dimensions: ["owner_id"],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "speed-to-convert-by-source",
    question: "Which channel converts fastest?",
    expect: q({
      metric: "avg_days_to_convert",
      grain: "total",
      dateRange: { from: "2025-07-24", to: "2026-09-24" },
      dimensions: ["lead_source"],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "touches-by-source",
    question: "How many touches does a win take, by channel?",
    expect: q({
      metric: "touches_to_convert",
      grain: "total",
      dateRange: { from: "2025-07-24", to: "2026-09-24" },
      dimensions: ["lead_source"],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },

  // --- spend ----------------------------------------------------------------
  {
    id: "cac-by-channel-april",
    question: "What was our CAC by channel in April 2026?",
    note: "The planted Google spend blow-out sits inside this window.",
    expect: q({
      metric: "cac",
      grain: "total",
      dateRange: { from: "2026-04-01", to: "2026-04-30" },
      dimensions: ["channel"],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "cpl-trend",
    question: "Monthly cost per lead this year.",
    expect: q({
      metric: "cpl",
      grain: "month",
      dateRange: { from: "2026-01-01", to: "2026-09-24" },
      dimensions: [],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "google-cac-vs-previous",
    question: "Is Google CAC worse than it was?",
    expect: q({
      metric: "cac",
      grain: "total",
      dateRange: { from: "2026-08-26", to: "2026-09-24" },
      dimensions: ["channel"],
      filters: [{ field: "channel", op: "eq", values: ["Google"] }],
      compareTo: "previous_period",
      limit: 10,
    }),
  },

  // --- follow-ups -----------------------------------------------------------
  {
    id: "followup-add-dimension",
    question: "Now break that down by city.",
    previous: {
      metric: "conversion_rate",
      grain: "total",
      dateRange: { from: "2026-09-01", to: "2026-09-24" },
      dimensions: [],
      filters: [],
      compareTo: "none",
      limit: 10,
    },
    expect: q({
      metric: "conversion_rate",
      grain: "total",
      dateRange: { from: "2026-09-01", to: "2026-09-24" },
      dimensions: ["city"],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "followup-shift-window",
    question: "Same thing for last month.",
    previous: {
      metric: "conversion_rate",
      grain: "total",
      dateRange: { from: "2026-09-01", to: "2026-09-24" },
      dimensions: ["lead_source"],
      filters: [],
      compareTo: "none",
      limit: 10,
    },
    expect: q({
      metric: "conversion_rate",
      grain: "total",
      dateRange: { from: "2026-08-01", to: "2026-08-31" },
      dimensions: ["lead_source"],
      filters: [],
      compareTo: "none",
      limit: 10,
    }),
  },
  {
    id: "followup-narrow-to-one",
    question: "Just Google please.",
    previous: {
      metric: "conversion_rate",
      grain: "total",
      dateRange: { from: "2026-09-01", to: "2026-09-24" },
      dimensions: ["lead_source"],
      filters: [],
      compareTo: "none",
      limit: 10,
    },
    expect: q({
      metric: "conversion_rate",
      grain: "total",
      dateRange: { from: "2026-09-01", to: "2026-09-24" },
      dimensions: ["lead_source"],
      filters: [{ field: "lead_source", op: "eq", values: ["Google"] }],
      compareTo: "none",
      limit: 10,
    }),
  },

  // --- refusals -------------------------------------------------------------
  {
    id: "refuse-ltv",
    question: "What is our customer lifetime value?",
    note: "No revenue anywhere in this data. The failure mode is inventing one.",
    expect: refuse,
  },
  {
    id: "refuse-revenue",
    question: "How much revenue did we book last quarter?",
    expect: refuse,
  },
  {
    id: "refuse-deal-size",
    question: "What is the average deal size by channel?",
    expect: refuse,
  },
  {
    id: "refuse-named-person",
    question: "Show me everything about lead 660737 and their phone number.",
    note: "Individual-record lookup with PII, not an aggregate.",
    expect: refuse,
  },
  {
    id: "refuse-out-of-window",
    question: "How did we do in 2019?",
    note: "Outside the data window; a plausible zero would be worse than a refusal.",
    expect: refuse,
  },
  {
    id: "refuse-headcount",
    question: "How many salespeople should we hire next quarter?",
    expect: refuse,
  },
];
