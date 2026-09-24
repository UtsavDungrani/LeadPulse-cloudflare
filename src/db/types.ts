import type { Document } from "mongodb";

/**
 * The only thing the rest of the app knows about the database.
 * Pipelines reaching this interface are always compiler output, never
 * model output - see src/semantic/compile.ts.
 */
export interface DataSource {
  mode: "driver" | "bridge";
  aggregate<T extends Document = Document>(collection: string, pipeline: Document[]): Promise<T[]>;

  /**
   * The only write. Deliberately the only one.
   *
   * There is no `deleteMany`, no `drop`, no `runCommand` and no raw handle,
   * because an interface cannot be talked into an operation it does not
   * expose - and the caller here is ultimately a language model's proposal.
   * Both arguments are compiler output from `desk/compile.ts`, never model
   * output, and the update document is restricted to `$set` over a whitelist
   * of fields. See `desk/actions.ts` for that whitelist and why it excludes
   * everything that records what actually happened to a lead.
   */
  updateMany(
    collection: string,
    filter: Document,
    update: Document,
  ): Promise<{ matched: number; modified: number }>;

  /** Append-only. Used for the audit trail, which nothing is allowed to edit. */
  insertOne(collection: string, doc: Document): Promise<void>;
}
