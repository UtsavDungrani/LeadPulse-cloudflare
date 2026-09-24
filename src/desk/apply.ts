/**
 * Preview, approve, apply, undo - the human-in-the-loop path.
 *
 * Nothing here is clever, and that is the point. The safety of a write path
 * comes from a small number of properties that are boring to state and easy to
 * check:
 *
 *  - **Nothing is written without a preview a person saw and approved.** The
 *    proposal carries the exact filter and update, not a description of them.
 *  - **The count is re-checked at approval.** If the number of matching leads
 *    moved between preview and approval, the world changed underneath the
 *    proposal and it is refused rather than applied to a different set.
 *  - **Proposals are single-use and expire.** An approval is for one specific
 *    change at one moment, not a standing permission.
 *  - **The prior value of every touched field is captured first**, so any
 *    action can be undone.
 *  - **Everything is written to an append-only audit collection**, including
 *    the compiled filter and update, so a change can be explained later.
 */
import type { Document } from "mongodb";
import type { DataSource } from "../db/types";
import {
  compileAction,
  compileCount,
  compilePreview,
  compileUndoCapture,
  type CompiledAction,
} from "./compile";
import { ActionError, describeAction, MAX_AFFECTED, type ActionIntent } from "./actions";

export const AUDIT_COLLECTION = "audit";
const SAMPLE_SIZE = 5;

/** How long an approval window stays open. */
export const PROPOSAL_TTL_MS = 15 * 60_000;

export interface ActionPreview {
  proposalId: string;
  intent: ActionIntent;
  summary: string;
  /** The exact query and write. Shown, not summarised. */
  compiled: { filter: Document; update: Document; guards: string[] };
  matched: number;
  sample: Document[];
  /** Current distribution of the field being overwritten, largest first. */
  currentValues: { value: string; count: number }[];
  /** How many of the matched leads already hold the target value. */
  alreadyCorrect: number;
  /** Non-null means this cannot be approved, and why. */
  blocked: string | null;
  expiresAt: string;
}

export interface AuditRecord {
  _id: string;
  at: string;
  proposalId: string;
  action: string;
  summary: string;
  reason: string;
  filter: Document;
  update: Document;
  previewMatched: number;
  matched: number;
  modified: number;
  /** Prior value of each touched field, per lead, so this can be reversed. */
  before: { _id: string; values: Document }[];
  /** Set on a reversal, naming the record it reverses. Null on an original. */
  undoOf: string | null;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Dry run. Reads only - this is the step that makes approval meaningful.
 */
export async function preview(ds: DataSource, intent: ActionIntent): Promise<ActionPreview> {
  const compiled = compileAction(intent);
  const [facet] = await ds.aggregate(compiled.collection, compilePreview(compiled, SAMPLE_SIZE));

  const matched = (facet?.matched as { n: number }[] | undefined)?.[0]?.n ?? 0;
  const sample = (facet?.sample as Document[] | undefined) ?? [];
  const current = ((facet?.current as { _id: unknown; n: number }[] | undefined) ?? []).map((r) => ({
    value: r._id === null || r._id === undefined ? "(unset)" : String(r._id),
    count: r.n,
  }));

  const target = compiled.update.$set[compiled.fields[0] as string];
  const alreadyCorrect = current.find((c) => c.value === String(target))?.count ?? 0;

  return {
    proposalId: id("prop"),
    intent,
    summary: describeAction(intent),
    compiled: { filter: compiled.filter, update: compiled.update, guards: compiled.guards },
    matched,
    sample,
    currentValues: current,
    alreadyCorrect,
    blocked: blockReason(matched, intent, alreadyCorrect),
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
  };
}

function blockReason(matched: number, intent: ActionIntent, alreadyCorrect: number): string | null {
  if (matched === 0) return "No leads match this proposal, so there is nothing to change.";
  if (matched > intent.limit) {
    return `${matched} leads match, which is more than the proposal's limit of ${intent.limit}. Narrow the filters or raise the limit deliberately.`;
  }
  if (matched > MAX_AFFECTED) {
    return `${matched} leads match, above the hard ceiling of ${MAX_AFFECTED}.`;
  }
  if (alreadyCorrect === matched) {
    return "Every matching lead already holds this value, so this would change nothing.";
  }
  return null;
}

/**
 * Apply an approved proposal.
 *
 * `expected` is the count the human saw. If the database no longer agrees, the
 * approval was for a different set of leads and is refused - this is the guard
 * against a slow approval, a concurrent change, or a replayed request.
 */
export async function apply(
  ds: DataSource,
  intent: ActionIntent,
  proposalId: string,
  expected: number,
): Promise<AuditRecord> {
  const compiled = compileAction(intent);
  const [count] = await ds.aggregate(compiled.collection, compileCount(compiled));
  const matched = (count?.n as number | undefined) ?? 0;

  if (matched !== expected) {
    throw new ActionError(
      `the data changed since the preview: ${expected} leads matched then, ${matched} match now. Re-run the proposal.`,
    );
  }
  const blocked = blockReason(matched, intent, 0);
  if (blocked) throw new ActionError(blocked);

  // Capture before writing. An undo that depends on a second read after the
  // update would have nothing left to read.
  const before = await captureBefore(ds, compiled, intent.limit);
  const result = await ds.updateMany(compiled.collection, compiled.filter, compiled.update);

  const record: AuditRecord = {
    _id: id("audit"),
    at: new Date().toISOString(),
    proposalId,
    action: intent.action,
    summary: describeAction(intent),
    reason: intent.reason,
    filter: compiled.filter,
    update: compiled.update,
    previewMatched: expected,
    matched: result.matched,
    modified: result.modified,
    before,
    undoOf: null,
  };
  await ds.insertOne(AUDIT_COLLECTION, record);
  return record;
}

async function captureBefore(
  ds: DataSource,
  compiled: CompiledAction,
  limit: number,
): Promise<AuditRecord["before"]> {
  const docs = await ds.aggregate(compiled.collection, compileUndoCapture(compiled, limit));
  return docs.map((d) => {
    const values: Document = {};
    for (const f of compiled.fields) values[f] = readPath(d, f);
    return { _id: String(d._id), values };
  });
}

function readPath(doc: Document, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, part) => {
    return acc && typeof acc === "object" ? (acc as Document)[part] : undefined;
  }, doc);
}

/**
 * Reverse an applied action from its audit record.
 *
 * Leads are grouped by the value they held, so restoring N documents takes one
 * update per distinct prior value rather than one per document. The undo is
 * itself audited, and an audit record can only be undone once.
 */
export async function undo(ds: DataSource, record: AuditRecord): Promise<AuditRecord> {
  // "Already undone" is derived from the presence of a reversal, not from a
  // flag on the original. The audit collection is append-only, and a trail you
  // are allowed to edit is not a trail.
  const [existing] = await ds.aggregate(AUDIT_COLLECTION, [
    { $match: { undoOf: record._id } },
    { $limit: 1 },
  ]);
  if (existing) throw new ActionError(`${record._id} has already been undone by ${existing._id}`);
  if (record.before.length === 0) throw new ActionError(`${record._id} captured no prior state`);

  const fields = Object.keys(record.before[0]!.values);
  const groups = new Map<string, { values: Document; ids: string[] }>();
  for (const row of record.before) {
    const key = JSON.stringify(fields.map((f) => row.values[f] ?? null));
    const group = groups.get(key) ?? { values: row.values, ids: [] };
    group.ids.push(row._id);
    groups.set(key, group);
  }

  let restored = 0;
  for (const group of groups.values()) {
    const $set: Document = {};
    for (const f of fields) $set[f] = group.values[f] ?? null;
    const r = await ds.updateMany("leads", { _id: { $in: group.ids } }, { $set });
    restored += r.modified;
  }

  const reversal: AuditRecord = {
    _id: id("audit"),
    at: new Date().toISOString(),
    proposalId: record.proposalId,
    action: `undo:${record.action}`,
    summary: `Reverted: ${record.summary}`,
    reason: `Undo of ${record._id}`,
    filter: { _id: { $in: record.before.map((b) => b._id) } },
    update: { $set: { restored: fields } },
    previewMatched: record.before.length,
    matched: record.before.length,
    modified: restored,
    before: [],
    undoOf: record._id,
  };
  await ds.insertOne(AUDIT_COLLECTION, reversal);
  return reversal;
}

/** Newest first. The audit trail is append-only; nothing edits it. */
export async function recentAudit(ds: DataSource, limit = 20): Promise<Document[]> {
  return ds.aggregate(AUDIT_COLLECTION, [
    { $sort: { at: -1 } },
    { $limit: limit },
    { $project: { before: 0 } },
  ]);
}

export async function findAudit(ds: DataSource, auditId: string): Promise<AuditRecord | null> {
  const [doc] = await ds.aggregate(AUDIT_COLLECTION, [{ $match: { _id: auditId } }, { $limit: 1 }]);
  return (doc as AuditRecord | undefined) ?? null;
}
