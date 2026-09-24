/**
 * JSON Schemas handed to the model, generated from the same Zod schemas that
 * validate the response. One definition, two uses - the schema the model is
 * constrained by cannot drift from the schema we enforce.
 */
import { z } from "zod";
import { QueryIntentSchema } from "../semantic/intent";
import { CHART_TYPES } from "../semantic/chart";

/**
 * `.refine()` checks (the `YYYY-MM-DD` test) have no JSON Schema equivalent.
 * `unrepresentable: "any"` drops them from the wire schema; Zod still enforces
 * them on the way back in, which is where enforcement belongs.
 */
function toSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

export const RUN_QUERY_SCHEMA = toSchema(QueryIntentSchema);

export const DeclineSchema = z.object({
  reason: z.string().max(500),
  suggestion: z.string().max(500),
});
export const DECLINE_SCHEMA = toSchema(DeclineSchema);

export const NarrationSchema = z.object({
  narrative: z.string().max(2000),
  headline: z.string().max(160),
  chartType: z.enum(CHART_TYPES),
});
export type Narration = z.infer<typeof NarrationSchema>;
export const NARRATION_SCHEMA = toSchema(NarrationSchema);
