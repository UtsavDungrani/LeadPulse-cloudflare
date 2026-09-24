/**
 * `QueryIntent` -> MongoDB aggregation pipeline. No AI anywhere in this file.
 *
 * Everything here is pure: same intent in, byte-identical pipeline out. That is
 * what makes the eval suite possible - a golden question maps to a golden
 * pipeline and the assertion is exact equality, not "looks about right".
 *
 * ## Top-N is two passes, on purpose
 * Ranking a *rate* needs the computed value, and the computation lives in
 * `metrics.ts` as TypeScript. Rather than restate every metric as a Mongo
 * expression - two definitions that will drift - the executor runs a cheap
 * ranking pass grouped by dimension only (at most a few hundred rows), picks
 * the winners in TypeScript, then runs the real time-series query restricted to
 * those members. One definition of the metric, bounded cardinality either way.
 */
import type { Document } from "mongodb";
import {
  coerceValue,
  field,
  PAID_CHANNELS,
  type DimensionId,
  type FieldDef,
} from "./fields";
import { metric, type MetricDef } from "./metrics";
import { rangeBounds, START_OF_WEEK, type DateRange, type Grain } from "./dates";
import type { Filter, QueryIntent } from "./intent";

/** Hard ceiling on grouped rows returned from one pipeline. */
export const MAX_GROUPS = 5000;

/**
 * `lead_source` values that carry media spend. `Bing` is absent: Phase 0 folded
 * the Bing tail into `Other` when canonicalising sources, so Bing spend has no
 * lead-side counterpart. Per-channel CAC for Bing is therefore undefined, while
 * the all-paid total stays correct because Bing's leads live inside `Other`.
 */
export const PAID_LEAD_SOURCES = ["Google", "Facebook", "Other"] as const;

export type PartName = "main" | "spend" | "conversions";

export interface CompiledPart {
  name: PartName;
  collection: "leads" | "channel_spend";
  pipeline: Document[];
}

export interface CompiledQuery {
  parts: CompiledPart[];
  /** Grain actually compiled - the ranking pass forces `total`. */
  grain: Grain;
  dimensions: readonly DimensionId[];
  range: DateRange;
}

/** Restricts a follow-up query to the dimension members chosen by the ranking pass. */
export type DimensionRestriction = Partial<Record<DimensionId, (string | null)[]>>;

export interface CompileOptions {
  /** Override the intent's grain - used to force `total` for the ranking pass. */
  grain?: Grain;
  restrictTo?: DimensionRestriction;
}

const DATE_FIELD: Record<MetricDef["engine"], string> = {
  leads: "created_at",
  touches: "created_at",
  spend: "day",
  cac: "created_at",
};

/** Dimension -> the field path used on each side of a CAC join. */
function dimensionPath(dim: DimensionId, collection: "leads" | "channel_spend"): string {
  if (dim === "channel") return collection === "channel_spend" ? "channel" : "lead_source";
  return field(dim).path;
}

function periodExpr(dateField: string, grain: Grain): Document {
  return {
    $dateTrunc: {
      date: `$${dateField}`,
      unit: grain,
      // Mongo defaults weeks to Sunday. Business weeks here start Monday, and
      // leaving the default in place shifts every weekly bucket by a day.
      ...(grain === "week" ? { startOfWeek: START_OF_WEEK } : {}),
    },
  };
}

function groupKey(
  dimensions: readonly DimensionId[],
  collection: "leads" | "channel_spend",
  dateField: string,
  grain: Grain,
): Document | null {
  const key: Document = {};
  if (grain !== "total") key.period = periodExpr(dateField, grain);
  dimensions.forEach((d, i) => {
    key[`d${i}`] = `$${dimensionPath(d, collection)}`;
  });
  return Object.keys(key).length === 0 ? null : key;
}

function sortStage(dimensions: readonly DimensionId[], grain: Grain): Document | null {
  const sort: Document = {};
  if (grain !== "total") sort["_id.period"] = 1;
  dimensions.forEach((_, i) => {
    sort[`_id.d${i}`] = 1;
  });
  return Object.keys(sort).length === 0 ? null : { $sort: sort };
}

/**
 * One validated filter -> one `$match` clause.
 *
 * Exported because the write path in `desk/compile.ts` selects the leads it
 * will change with exactly this vocabulary. The whitelist that protects reads
 * is the whitelist that protects writes; there is no second, looser one.
 */
export function filterClause(f: Filter): Document {
  const def: FieldDef = field(f.field);
  const path = def.path;
  const one = () => coerceValue(def, f.values[0] as string);
  const many = () => f.values.map((v) => coerceValue(def, v));

  switch (f.op) {
    case "eq":
      return { [path]: one() };
    case "ne":
      return { [path]: { $ne: one() } };
    case "in":
      return { [path]: { $in: many() } };
    case "nin":
      return { [path]: { $nin: many() } };
    case "gt":
      return { [path]: { $gt: one() } };
    case "gte":
      return { [path]: { $gte: one() } };
    case "lt":
      return { [path]: { $lt: one() } };
    case "lte":
      return { [path]: { $lte: one() } };
    case "is_null":
      // Matches both explicit null and a missing path, which is what a user
      // means by "unknown city".
      return { [path]: null };
    case "is_not_null":
      return { [path]: { $ne: null } };
  }
}

function restrictionClauses(
  restrictTo: DimensionRestriction | undefined,
  dimensions: readonly DimensionId[],
  collection: "leads" | "channel_spend",
): Document[] {
  if (!restrictTo) return [];
  const out: Document[] = [];
  for (const d of dimensions) {
    const members = restrictTo[d];
    if (members && members.length > 0) {
      out.push({ [dimensionPath(d, collection)]: { $in: members } });
    }
  }
  return out;
}

function matchStage(args: {
  dateField: string;
  range: DateRange;
  extra: Document[];
}): Document {
  const { start, endExclusive } = rangeBounds(args.range);
  const match: Document = { [args.dateField]: { $gte: start, $lt: endExclusive } };
  if (args.extra.length > 0) match.$and = args.extra;
  return { $match: match };
}

/**
 * Pulls the activity count onto each lead before grouping.
 *
 * The sub-pipeline form (rather than `localField`/`foreignField`) is
 * deliberate: it hits `lead_number_1_ts_1` and returns a single count document
 * per lead instead of dragging every activity into memory.
 */
function touchLookupStages(): Document[] {
  return [
    {
      $lookup: {
        from: "activities",
        let: { ln: "$lead_number" },
        pipeline: [{ $match: { $expr: { $eq: ["$lead_number", "$$ln"] } } }, { $count: "c" }],
        as: "_touches",
      },
    },
    { $addFields: { touch_count: { $ifNull: [{ $arrayElemAt: ["$_touches.c", 0] }, 0] } } },
  ];
}

function buildPipeline(args: {
  collection: "leads" | "channel_spend";
  dateField: string;
  range: DateRange;
  extraMatch: Document[];
  preGroup?: Document[];
  accumulators: Document;
  dimensions: readonly DimensionId[];
  grain: Grain;
}): Document[] {
  const stages: Document[] = [
    matchStage({ dateField: args.dateField, range: args.range, extra: args.extraMatch }),
    ...(args.preGroup ?? []),
    { $group: { _id: groupKey(args.dimensions, args.collection, args.dateField, args.grain), ...args.accumulators } },
  ];
  const sort = sortStage(args.dimensions, args.grain);
  if (sort) stages.push(sort);
  stages.push({ $limit: MAX_GROUPS });
  return stages;
}

/**
 * Compile an intent into the pipelines that answer it for one date range.
 *
 * `range` is passed separately from `intent.dateRange` because the comparison
 * period reuses the same intent against a shifted window.
 */
export function compileQuery(
  intent: QueryIntent,
  range: DateRange,
  opts: CompileOptions = {},
): CompiledQuery {
  const m = metric(intent.metric);
  const grain = opts.grain ?? intent.grain;
  const dimensions = intent.dimensions;
  const dateField = DATE_FIELD[m.engine];

  const userFilters = intent.filters.map(filterClause);
  const prefilter = m.prefilter ? [m.prefilter] : [];

  switch (m.engine) {
    case "leads":
    case "touches": {
      const extra = [
        ...prefilter,
        ...userFilters,
        ...restrictionClauses(opts.restrictTo, dimensions, "leads"),
      ];
      return {
        parts: [
          {
            name: "main",
            collection: "leads",
            pipeline: buildPipeline({
              collection: "leads",
              dateField,
              range,
              extraMatch: extra,
              preGroup: m.engine === "touches" ? touchLookupStages() : undefined,
              accumulators: m.accumulators,
              dimensions,
              grain,
            }),
          },
        ],
        grain,
        dimensions,
        range,
      };
    }

    case "spend": {
      const extra = [
        ...prefilter,
        ...userFilters,
        ...restrictionClauses(opts.restrictTo, dimensions, "channel_spend"),
      ];
      return {
        parts: [
          {
            name: "main",
            collection: "channel_spend",
            pipeline: buildPipeline({
              collection: "channel_spend",
              dateField: "day",
              range,
              extraMatch: extra,
              accumulators: m.accumulators,
              dimensions,
              grain,
            }),
          },
        ],
        grain,
        dimensions,
        range,
      };
    }

    case "cac": {
      // Two independent aggregations joined in TypeScript on (period, channel).
      // A `$lookup` across collections with different date fields and different
      // grains would be both slower and far harder to reason about.
      const spendExtra = [
        ...userFilters,
        ...restrictionClauses(opts.restrictTo, dimensions, "channel_spend"),
        { channel: { $in: [...PAID_CHANNELS] } },
      ];
      const convExtra = [
        ...restrictionClauses(opts.restrictTo, dimensions, "leads"),
        { lead_source: { $in: [...PAID_LEAD_SOURCES] } },
      ];
      return {
        parts: [
          {
            name: "spend",
            collection: "channel_spend",
            pipeline: buildPipeline({
              collection: "channel_spend",
              dateField: "day",
              range,
              extraMatch: spendExtra,
              accumulators: { spend: { $sum: "$spend_inr" }, spend_leads: { $sum: "$leads" } },
              dimensions,
              grain,
            }),
          },
          {
            name: "conversions",
            collection: "leads",
            pipeline: buildPipeline({
              collection: "leads",
              dateField: "created_at",
              range,
              extraMatch: convExtra,
              accumulators: {
                n: { $sum: 1 },
                won: { $sum: { $cond: [{ $eq: ["$converted", true] }, 1, 0] } },
              },
              dimensions,
              grain,
            }),
          },
        ],
        grain,
        dimensions,
        range,
      };
    }
  }
}

/**
 * The ranking pass: same filters, collapsed to one row per dimension
 * combination, so top-N can be decided on the real metric value.
 */
export function compileRankingQuery(intent: QueryIntent, range: DateRange): CompiledQuery {
  return compileQuery(intent, range, { grain: "total" });
}

/** True when a ranking pass is worth running at all. */
export function needsRanking(intent: QueryIntent): boolean {
  return intent.dimensions.length > 0 && intent.grain !== "total";
}
