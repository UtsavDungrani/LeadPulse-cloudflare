/**
 * `ActionIntent` -> a Mongo filter and update. No AI in this file.
 *
 * Pure, so the exact write can be unit-tested against a golden document and
 * shown to a human before anything happens. The preview a person approves is
 * this function's output, not a paraphrase of it.
 */
import type { Document } from "mongodb";
import { filterClause } from "../semantic/compile";
import { coerceValue } from "../semantic/fields";
import { rangeBounds } from "../semantic/dates";
import { ACTION_FIELDS, OPEN_STAGES, type ActionIntent } from "./actions";

export interface CompiledAction {
  collection: "leads";
  filter: Document;
  /** Always a single `$set`. There is no code path that emits anything else. */
  update: { $set: Document };
  /** Paths this writes, for the audit record and the undo capture. */
  fields: string[];
  /** Guards the compiler added that the user did not ask for, in plain words. */
  guards: string[];
}

export function compileAction(intent: ActionIntent): CompiledAction {
  const target = ACTION_FIELDS[intent.action];
  const { start, endExclusive } = rangeBounds(intent.dateRange);

  const clauses: Document[] = intent.filters.map(filterClause);
  const guards: string[] = [];

  // A stage change must never touch a lead that already converted. Its stage is
  // part of the record of what happened, and moving a Won lead to "Attempting"
  // would silently contradict `converted` for every metric downstream.
  if (intent.action === "set_stage") {
    clauses.push({ converted: false });
    guards.push("converted leads are excluded - their stage records an outcome");
  }

  const $set: Document = { [target.path]: coerceForAction(intent) };

  // `stage` and `is_open` are two views of one fact. Writing one without the
  // other makes `open_pipeline` disagree with `stage`, and nothing downstream
  // would notice until someone questioned a report.
  if (intent.action === "set_stage") {
    $set.is_open = (OPEN_STAGES as readonly string[]).includes(intent.value);
    guards.push(`is_open set to ${$set.is_open} to stay consistent with the stage`);
  }

  return {
    collection: "leads",
    filter: { created_at: { $gte: start, $lt: endExclusive }, $and: clauses },
    update: { $set },
    fields: Object.keys($set),
    guards,
  };
}

function coerceForAction(intent: ActionIntent): string | boolean | number {
  // Reuse the read path's coercion so "true" means the same thing on both
  // sides of the system.
  return coerceValue(ACTION_FIELDS[intent.action], intent.value);
}

/**
 * The pipeline that reads back what is about to be overwritten.
 *
 * Captured before every apply, so an action can be undone field by field. A
 * bulk update with no record of the prior state is a change you cannot take
 * back, which is not a thing to hand a language model.
 */
export function compileUndoCapture(compiled: CompiledAction, limit: number): Document[] {
  const projection: Document = { _id: 1, lead_number: 1 };
  for (const f of compiled.fields) projection[f] = 1;
  return [{ $match: compiled.filter }, { $limit: limit }, { $project: projection }];
}

/** Just the count. `$limit: 0` is an error in Mongo, so the preview facet cannot be reused. */
export function compileCount(compiled: CompiledAction): Document[] {
  return [{ $match: compiled.filter }, { $count: "n" }];
}

/** The pipeline behind the preview: how many, and what they look like now. */
export function compilePreview(compiled: CompiledAction, sampleSize: number): Document[] {
  return [
    { $match: compiled.filter },
    {
      $facet: {
        matched: [{ $count: "n" }],
        sample: [
          { $limit: sampleSize },
          {
            $project: {
              _id: 0,
              lead_number: 1,
              owner_id: 1,
              stage: 1,
              lead_source: 1,
              created_at: 1,
              is_open: 1,
            },
          },
        ],
        // What is being overwritten, and how much of each. Someone approving a
        // reassignment should see that 90% of it is already assigned to the
        // person they are "moving" it to.
        current: [
          { $group: { _id: `$${compiled.fields[0]}`, n: { $sum: 1 } } },
          { $sort: { n: -1 } },
          { $limit: 10 },
        ],
      },
    },
  ];
}
