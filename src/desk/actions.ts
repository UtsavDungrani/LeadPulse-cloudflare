/**
 * `ActionIntent` - the write-side counterpart to `QueryIntent`.
 *
 * Same architecture as the read path, for the same reasons: the model proposes
 * a typed object, Zod validates it, and a deterministic compiler turns it into
 * a Mongo update. The model never writes a filter and never writes an update
 * document.
 *
 * ## The rule that decides what is writable
 * Phase 0's central rule was **outcomes are never invented; only timing is
 * synthesised**. This is the same rule carried into the write path:
 *
 * > The desk can change **how you work a lead**. It can never change **what
 * > happened to it**.
 *
 * So `owner_id`, `stage` and the consent flags are writable - those are
 * workflow. `converted`, `converted_at`, `days_to_convert`, `created_at`,
 * `lead_source` and the whole `analysis_only` subtree are not, because they are
 * either observed facts or provenance. A copilot that can quietly mark a lead
 * as converted is a copilot that can corrupt every number the other two agents
 * report.
 *
 * That is also why `Won` is not an assignable stage: it is an outcome wearing a
 * workflow field's clothing.
 */
import { z } from "zod";
import { FilterSchema, type Filter } from "../semantic/intent";
import { isIsoDay, toDay } from "../semantic/dates";
import { STAGES } from "../semantic/fields";

export const ACTIONS = [
  "reassign_owner",
  "set_stage",
  "set_do_not_email",
  "set_do_not_call",
] as const;
export type ActionId = (typeof ACTIONS)[number];

/** Stages a lead is still being worked in. Everything else is terminal. */
export const OPEN_STAGES = ["New", "Attempting", "Engaged", "Qualified"] as const;

/**
 * Stages the desk may assign.
 *
 * `Won` is absent deliberately - see the file header. `Lost`, `Unreachable` and
 * `Disqualified` are judgement calls a rep genuinely makes, so they stay.
 */
export const ASSIGNABLE_STAGES = STAGES.filter((s) => s !== "Won");

/** Field touched by each action, and how its value is read. */
export const ACTION_FIELDS: Record<ActionId, { path: string; type: "string" | "bool"; label: string }> = {
  reassign_owner: { path: "owner_id", type: "string", label: "owner" },
  set_stage: { path: "stage", type: "string", label: "stage" },
  set_do_not_email: { path: "consent.do_not_email", type: "bool", label: "do-not-email" },
  set_do_not_call: { path: "consent.do_not_call", type: "bool", label: "do-not-call" },
};

/**
 * Hard ceiling, above the per-proposal `limit`. Nothing gets to raise it,
 * including a model that decides a bulk change is warranted.
 */
export const MAX_AFFECTED = 500;

const isoDay = z.string().refine(isIsoDay, "expected a YYYY-MM-DD date");

export const ActionIntentSchema = z.object({
  action: z.enum(ACTIONS),
  /**
   * Who to act on, in the same vocabulary the Analyst uses. At least one is
   * required: combined with `dateRange`, this is what makes "change every lead
   * in the database" unexpressible rather than merely discouraged.
   */
  filters: z.array(FilterSchema).min(1).max(10),
  /** Creation window. Required, for the same reason. */
  dateRange: z.object({ from: isoDay, to: isoDay }),
  /** New value as a string; coerced against the target field's declared type. */
  value: z.string().min(1).max(100),
  /** Recorded verbatim in the audit trail. */
  reason: z.string().min(3).max(300),
  /** Refuse to apply if more leads than this match. */
  limit: z.number().int().min(1).max(MAX_AFFECTED),
});

export type ActionIntent = z.infer<typeof ActionIntentSchema>;

/** What the model produces: a proposal, or a documented refusal. */
export type DeskPlan =
  | { kind: "action"; intent: ActionIntent }
  | { kind: "refusal"; reason: string; suggestion: string };

export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

const REP_ID = /^REP\d{3}$/;

/**
 * Validate shape, then answerability. Both failures are recoverable: the
 * message goes back to the model as a repair prompt, exactly as on the read
 * side.
 */
export function validateAction(raw: unknown): ActionIntent {
  const parsed = ActionIntentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ActionError(`malformed ActionIntent - ${issues}`);
  }
  const intent = parsed.data;

  if (toDay(intent.dateRange.to) < toDay(intent.dateRange.from)) {
    throw new ActionError(
      `dateRange runs backwards: ${intent.dateRange.from} is after ${intent.dateRange.to}`,
    );
  }

  switch (intent.action) {
    case "reassign_owner":
      if (!REP_ID.test(intent.value)) {
        throw new ActionError(`"${intent.value}" is not a rep id; expected the form REP007`);
      }
      break;
    case "set_stage":
      if (intent.value === "Won") {
        throw new ActionError(
          "stage cannot be set to Won: conversion is an observed outcome, not something the desk assigns",
        );
      }
      if (!ASSIGNABLE_STAGES.includes(intent.value as (typeof ASSIGNABLE_STAGES)[number])) {
        throw new ActionError(
          `"${intent.value}" is not an assignable stage; choose one of ${ASSIGNABLE_STAGES.join(", ")}`,
        );
      }
      break;
    case "set_do_not_email":
    case "set_do_not_call":
      if (!["true", "false"].includes(intent.value.toLowerCase())) {
        throw new ActionError(`${intent.action} takes "true" or "false", not "${intent.value}"`);
      }
      break;
  }

  return intent;
}

/** Human-readable one-liner, used in the preview and the audit record. */
export function describeAction(intent: ActionIntent): string {
  const f = ACTION_FIELDS[intent.action];
  const where = intent.filters.map(describeFilter).join(" and ");
  return `Set ${f.label} to "${intent.value}" for leads created ${intent.dateRange.from} to ${intent.dateRange.to} where ${where}`;
}

function describeFilter(f: Filter): string {
  switch (f.op) {
    case "is_null":
      return `${f.field} is unknown`;
    case "is_not_null":
      return `${f.field} is known`;
    case "in":
      return `${f.field} is one of ${f.values.join(", ")}`;
    case "nin":
      return `${f.field} is not one of ${f.values.join(", ")}`;
    case "eq":
      return `${f.field} is ${f.values[0]}`;
    case "ne":
      return `${f.field} is not ${f.values[0]}`;
    default:
      return `${f.field} ${f.op} ${f.values[0]}`;
  }
}
