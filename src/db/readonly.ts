/**
 * Read-only `DataSource` wrappers.
 *
 * The Analyst and the Watchtower have no business writing to the database, so
 * they are handed a source that physically cannot. This is defence in depth
 * rather than paranoia: the write path exists a couple of imports away, and an
 * accidental call - a copy-pasted helper, a future refactor, a well-meaning
 * "just mark it read" feature - should fail loudly at the seam instead of
 * quietly modifying nine thousand leads.
 *
 * Only `LeadDeskAgent` is given a writable source, and even there every
 * mutation goes through `desk/compile.ts` and a human approval.
 */
import type { Document } from "mongodb";
import type { DataSource } from "./types";

export class ReadOnlyViolation extends Error {
  constructor(operation: string, collection: string) {
    super(`${operation} on "${collection}" was attempted through a read-only data source`);
    this.name = "ReadOnlyViolation";
  }
}

/** Wrap an existing source so its writes throw. */
export function readOnly(ds: DataSource): DataSource {
  return {
    mode: ds.mode,
    aggregate: (collection, pipeline) => ds.aggregate(collection, pipeline),
    updateMany(collection) {
      throw new ReadOnlyViolation("updateMany", collection);
    },
    insertOne(collection) {
      throw new ReadOnlyViolation("insertOne", collection);
    },
  };
}

/**
 * Build a read-only source from an aggregate function alone. Used by tests,
 * which want to supply a driver handle without restating the write methods.
 */
export function readOnlyFrom(
  aggregate: (collection: string, pipeline: Document[]) => Promise<Document[]>,
  mode: DataSource["mode"] = "driver",
): DataSource {
  return readOnly({
    mode,
    aggregate: aggregate as DataSource["aggregate"],
    updateMany: () => Promise.reject(new Error("unreachable")),
    insertOne: () => Promise.reject(new Error("unreachable")),
  });
}
