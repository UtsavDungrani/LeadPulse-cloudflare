import type { Document } from "mongodb";

/**
 * The only thing the rest of the app knows about the database.
 * Pipelines reaching this interface are always compiler output, never
 * model output - see src/semantic/compile.ts.
 */
export interface DataSource {
  mode: "driver" | "bridge";
  aggregate<T extends Document = Document>(collection: string, pipeline: Document[]): Promise<T[]>;
}
