/**
 * `QueryIntent` - the contract between the language model and the database.
 *
 * The model never writes a pipeline. It fills in this object, we validate it,
 * and a deterministic compiler turns it into aggregation stages. Three reasons,
 * in the order they will bite you:
 *
 *  - **Safety.** A generated pipeline can reach `$where`, `$function` or a
 *    `$lookup` into any collection. There is no reliable way to sanitise
 *    generated code; there is a very reliable way to validate a typed object.
 *  - **Cost.** An unindexed `$group` is free at 9k documents and fatal at 9M.
 *    The compiler knows which indexes exist. The model does not.
 *  - **Testability.** You cannot regression-test free-form code. You can
 *    exact-match a compiled pipeline against a golden one.
 *
 * ## Why the wire shape is deliberately boring
 * Every field is a required scalar, enum, or array of those. No unions, no
 * nullables, no free-form strings where an enum will do. Strict tool schemas
 * and JSON-schema structured output both handle that subset without surprises,
 * and a filter value is always a `string[]` (`values`) rather than
 * `string | number | boolean | string[]` for the same reason - the compiler
 * coerces against the declared field type in `fields.ts`, where the type is
 * actually known.
 */
import { z } from "zod";
import { DIMENSION_IDS, FILTER_OPS, FIELD_IDS, opAllowedFor, field, type FieldId } from "./fields";
import { METRIC_IDS, metric, isSpendSourced, type MetricId } from "./metrics";
import { isIsoDay, toDay, type Grain } from "./dates";

export const GRAINS = ["total", "day", "week", "month", "quarter"] as const;
export const COMPARE_MODES = ["none", "previous_period", "same_period_last_year"] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

const isoDay = z.string().refine(isIsoDay, "expected a YYYY-MM-DD date");

export const FilterSchema = z.object({
  field: z.enum(FIELD_IDS as [FieldId, ...FieldId[]]),
  op: z.enum(FILTER_OPS),
  /**
   * Always an array of strings. `eq`/`ne` and the comparison ops use the first
   * entry; `in`/`nin` use all of them; `is_null`/`is_not_null` ignore it.
   */
  values: z.array(z.string()).max(50),
});
export type Filter = z.infer<typeof FilterSchema>;

export const QueryIntentSchema = z.object({
  metric: z.enum(METRIC_IDS as [MetricId, ...MetricId[]]),
  /** `total` collapses the whole range into one bucket per dimension combination. */
  grain: z.enum(GRAINS),
  dateRange: z.object({ from: isoDay, to: isoDay }),
  /** At most two - a third axis is unreadable in every chart type we emit. */
  dimensions: z.array(z.enum(DIMENSION_IDS)).max(2),
  filters: z.array(FilterSchema).max(10),
  compareTo: z.enum(COMPARE_MODES),
  /** Series or rows kept after ranking. */
  limit: z.number().int().min(1).max(100),
});

export type QueryIntent = z.infer<typeof QueryIntentSchema>;

/** What the model produces: either a query, or a documented refusal. */
/**
 * The question that names no metric.
 *
 * "How did yesterday go" asks for the pipeline, not for one number out of it.
 * There is deliberately no `metric` field to guess at and no `dimensions` - an
 * overview is a window, and that is all it is. Anything more specific is a
 * `QueryIntent`, which is a better answer whenever the question supports one.
 *
 * There is no `compareTo` either, and that is the same decision: "how did
 * yesterday go" is a question about a change, so the comparison is not
 * optional. Leaving it to the model produced overviews with no deltas at all,
 * which is the least useful version of this answer. A field that should always
 * have one value is better removed than defaulted.
 */
export const OverviewIntentSchema = z.object({
  dateRange: z.object({ from: isoDay, to: isoDay }),
  filters: z
    .array(FilterSchema)
    .max(10)
    .describe(
      "Almost always empty. Set it only when the question names a segment, as in " +
        "'how did Google do last week'. Never add a filter the question did not ask for.",
    ),
});

export type OverviewIntent = z.infer<typeof OverviewIntentSchema>;

export type AgentPlan =
  | { kind: "query"; intent: QueryIntent }
  | { kind: "overview"; overview: OverviewIntent }
  | { kind: "refusal"; reason: string; suggestion: string };

export class IntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntentError";
  }
}

/**
 * Semantic validation on top of the shape check. Zod proves the object is
 * well-formed; this proves it is answerable. Both failures are recoverable -
 * the message is fed back to the model as a repair prompt.
 */
export function validateIntent(raw: unknown): QueryIntent {
  const parsed = QueryIntentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new IntentError(`malformed QueryIntent - ${issues}`);
  }
  const intent = parsed.data;
  const m = metric(intent.metric);

  if (toDay(intent.dateRange.to) < toDay(intent.dateRange.from)) {
    throw new IntentError(
      `dateRange runs backwards: ${intent.dateRange.from} is after ${intent.dateRange.to}`,
    );
  }

  const seen = new Set<string>();
  for (const d of intent.dimensions) {
    if (seen.has(d)) throw new IntentError(`dimension "${d}" is listed twice`);
    seen.add(d);

    const why = m.incompatibleDimensions?.[d];
    if (why) throw new IntentError(`${m.label} cannot be split by ${d}: ${why}`);

    if (d === "channel" && !isSpendSourced(m)) {
      throw new IntentError(
        `"channel" is a spend dimension; for ${m.label} split by lead_source instead`,
      );
    }
    if (isSpendSourced(m) && d !== "channel") {
      throw new IntentError(
        `${m.label} comes from channel_spend and can only be split by channel`,
      );
    }
  }

  for (const f of intent.filters) {
    const def = field(f.field);
    if (!opAllowedFor(def.type, f.op)) {
      throw new IntentError(`operator "${f.op}" does not apply to ${f.field} (${def.type})`);
    }
    const needsValue = f.op !== "is_null" && f.op !== "is_not_null";
    if (needsValue && f.values.length === 0) {
      throw new IntentError(`filter on ${f.field} with op "${f.op}" needs at least one value`);
    }
    if (isSpendSourced(m) && def.source !== "channel_spend") {
      throw new IntentError(
        `${m.label} reads channel_spend and cannot filter on ${f.field}, which is a lead field`,
      );
    }
    if (!isSpendSourced(m) && def.source === "channel_spend") {
      throw new IntentError(`${m.label} reads leads and cannot filter on the spend field ${f.field}`);
    }
  }

  return intent;
}

/**
 * The same checks the single-metric path applies, minus the ones about a metric
 * there isn't one of. Whether each individual metric can carry these filters is
 * decided per metric when the overview runs - `cpl` reads channel spend and
 * cannot be filtered by a lead field, and dropping it is better than refusing
 * the whole overview.
 */
export function validateOverview(raw: unknown): OverviewIntent {
  const parsed = OverviewIntentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new IntentError(`malformed OverviewIntent - ${issues}`);
  }
  const intent = parsed.data;

  if (toDay(intent.dateRange.to) < toDay(intent.dateRange.from)) {
    throw new IntentError(
      `dateRange runs backwards: ${intent.dateRange.from} is after ${intent.dateRange.to}`,
    );
  }

  const sources = new Set<string>();
  for (const f of intent.filters) {
    const def = field(f.field);
    sources.add(def.source);
    if (!opAllowedFor(def.type, f.op)) {
      throw new IntentError(`operator "${f.op}" does not apply to ${f.field} (${def.type})`);
    }
    const needsValue = f.op !== "is_null" && f.op !== "is_not_null";
    if (needsValue && f.values.length === 0) {
      throw new IntentError(`filter on ${f.field} with op "${f.op}" needs at least one value`);
    }
  }

  /*
   * No metric reads both collections, so a filter set spanning both leaves
   * every tile unrunnable and the overview empty. Rejecting it here turns a
   * blank answer into a repair prompt, which is what caught a planner that had
   * padded `filters` with an `is_not_null` on every field it could name.
   */
  if (sources.size > 1) {
    throw new IntentError(
      `filters mix lead fields with channel_spend fields (${[...sources].join(", ")}); ` +
        `no single metric reads both, so nothing could be reported. Filter on one or the other, or on neither.`,
    );
  }

  return intent;
}

/**
 * Merge a patch into the previous intent. This is what makes a follow-up like
 * "now break that by city" a one-field edit rather than a fresh guess at the
 * whole question - and it is the main reason the agent is stateful at all.
 */
export function patchIntent(base: QueryIntent, patch: Partial<QueryIntent>): QueryIntent {
  return validateIntent({ ...base, ...patch });
}

export function grainOf(intent: QueryIntent): Grain {
  return intent.grain;
}
