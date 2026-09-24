/**
 * The whitelist. Nothing outside this file can be grouped by or filtered on.
 *
 * This is the security boundary as much as the usability one: the compiler
 * only ever writes field paths it looked up here, so a model that invents
 * `$where` or a path into `analysis_only` gets a validation error, not a query.
 */

export type FieldType = "string" | "bool" | "number";

export interface FieldDef {
  /** Dotted path in the `leads` document (or `channel_spend` where noted). */
  path: string;
  type: FieldType;
  /** Which collection this field lives in. */
  source: "leads" | "channel_spend";
  /** Shown to the model so it picks real fields with real values. */
  description: string;
  /** Low-cardinality enums are listed verbatim in the prompt. */
  values?: readonly string[];
}

export const LEAD_SOURCES = [
  "Direct Traffic", "Facebook", "Google", "Olark Chat", "Organic Search",
  "Other", "Reference", "Referral Sites", "Unknown", "Welingak Website",
] as const;

export const LEAD_ORIGINS = [
  "API", "Landing Page Submission", "Lead Add Form", "Lead Import", "Quick Add Form",
] as const;

export const STAGES = [
  "New", "Attempting", "Engaged", "Qualified", "Won", "Lost", "Unreachable", "Disqualified",
] as const;

/** Ordered for the funnel chart; terminal states sit outside the funnel. */
export const FUNNEL_STAGES = ["New", "Attempting", "Engaged", "Qualified", "Won"] as const;

export const OCCUPATIONS = [
  "Businessman", "Housewife", "Other", "Student", "Unemployed", "Working Professional",
] as const;

export const CITIES = [
  "Mumbai", "Other Cities", "Other Cities of Maharashtra", "Other Metro Cities",
  "Thane & Outskirts", "Tier II Cities",
] as const;

export const SPEND_CHANNELS = ["Bing", "Facebook", "Google", "Other"] as const;

/**
 * `lead_source` values that carry media cost. Everything else is free traffic,
 * so CPL/CAC are undefined there rather than zero - reporting a ₹0 CAC for
 * Reference would be the kind of confidently wrong number this whole design
 * exists to prevent.
 *
 * Note `Bing` appears in `channel_spend` but not in `lead_source`: Phase 0
 * bucketed the Bing tail into `Other` when canonicalising sources.
 */
export const PAID_CHANNELS = SPEND_CHANNELS;

export const FIELDS = {
  lead_source:        { path: "lead_source",                source: "leads", type: "string", description: "Acquisition channel.", values: LEAD_SOURCES },
  lead_origin:        { path: "lead_origin",                source: "leads", type: "string", description: "How the lead entered the system.", values: LEAD_ORIGINS },
  stage:              { path: "stage",                      source: "leads", type: "string", description: "Current pipeline stage.", values: STAGES },
  owner_id:           { path: "owner_id",                   source: "leads", type: "string", description: "Sales rep who owns the lead (REP001..REP012)." },
  is_open:            { path: "is_open",                    source: "leads", type: "bool",   description: "Still working: not Won, Lost, Unreachable or Disqualified." },
  converted:          { path: "converted",                  source: "leads", type: "bool",   description: "Lead became a customer." },
  sla_breached:       { path: "sla.breached",               source: "leads", type: "bool",   description: "First response missed the SLA." },
  city:               { path: "profile.city",               source: "leads", type: "string", description: "City (India only; ~24% unknown).", values: CITIES },
  country:            { path: "profile.country",            source: "leads", type: "string", description: "Country." },
  specialization:     { path: "profile.specialization",     source: "leads", type: "string", description: "Course specialisation of interest (~21% unknown)." },
  occupation:         { path: "profile.occupation",         source: "leads", type: "string", description: "Current occupation.", values: OCCUPATIONS },
  primary_motivation: { path: "profile.primary_motivation", source: "leads", type: "string", description: "Stated reason for enrolling." },
  heard_from:         { path: "profile.heard_from",         source: "leads", type: "string", description: "Self-reported attribution (~55% unknown)." },
  last_activity:      { path: "engagement.last_activity",   source: "leads", type: "string", description: "Most recent activity recorded on the lead." },
  do_not_email:       { path: "consent.do_not_email",       source: "leads", type: "bool",   description: "Opted out of email." },
  do_not_call:        { path: "consent.do_not_call",        source: "leads", type: "bool",   description: "Opted out of calls." },
  total_visits:       { path: "engagement.total_visits",    source: "leads", type: "number", description: "Website visits before conversion." },
  time_on_site_sec:   { path: "engagement.time_on_site_sec",source: "leads", type: "number", description: "Total seconds on site." },
  days_to_convert:    { path: "days_to_convert",            source: "leads", type: "number", description: "Days from creation to conversion (converted leads only)." },
  first_response_min: { path: "sla.first_response_minutes", source: "leads", type: "number", description: "Minutes to first rep response." },
  channel:            { path: "channel",                    source: "channel_spend", type: "string", description: "Paid media channel (spend only).", values: SPEND_CHANNELS },
} as const satisfies Record<string, FieldDef>;

export type FieldId = keyof typeof FIELDS;
export const FIELD_IDS = Object.keys(FIELDS) as FieldId[];

/**
 * Fields that make sense as a `GROUP BY`. High-cardinality or continuous
 * fields are filter-only - grouping conversion rate by `time_on_site_sec`
 * produces thousands of one-row buckets and answers nothing.
 */
export const DIMENSION_IDS = [
  "lead_source", "lead_origin", "stage", "owner_id", "city", "country",
  "specialization", "occupation", "primary_motivation", "heard_from",
  "last_activity", "is_open", "converted", "sla_breached", "channel",
] as const satisfies readonly FieldId[];

export type DimensionId = (typeof DIMENSION_IDS)[number];

export const FILTER_OPS = [
  "eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "is_null", "is_not_null",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Ops that are meaningless for a given field type, rejected at validation. */
const NUMERIC_ONLY: readonly FilterOp[] = ["gt", "gte", "lt", "lte"];

export function opAllowedFor(type: FieldType, op: FilterOp): boolean {
  if (NUMERIC_ONLY.includes(op)) return type === "number";
  return true;
}

export function field(id: FieldId): FieldDef {
  return FIELDS[id];
}

/**
 * Filter values arrive from the model as strings - a single JSON type keeps
 * the tool schema strict-safe. Coercion happens here, against the declared
 * field type, so `converted = "true"` becomes a boolean and never matches
 * nothing forever.
 */
export function coerceValue(f: FieldDef, raw: string): string | number | boolean {
  switch (f.type) {
    case "bool": {
      const v = raw.trim().toLowerCase();
      if (["true", "yes", "1"].includes(v)) return true;
      if (["false", "no", "0"].includes(v)) return false;
      throw new RangeError(`${f.path} is boolean; cannot read ${JSON.stringify(raw)}`);
    }
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new RangeError(`${f.path} is numeric; cannot read ${JSON.stringify(raw)}`);
      return n;
    }
    default:
      return raw;
  }
}
