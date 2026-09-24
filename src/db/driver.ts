/**
 * Data path: MongoDB driver running inside the Worker.
 *
 * Verified 2026-09-24 against local Mongo 8.3 under wrangler dev with
 * `nodejs_compat` (node:net / node:tls / node:dns are polyfilled over
 * cloudflare:sockets). See HANDOFF.md §5 for the Atlas caveat.
 *
 * Ownership rule: a MongoClient holds open sockets, and workerd cancels a
 * request that touches I/O created by a *different* request ("code had hung").
 * So the client must live inside a Durable Object, whose I/O context spans its
 * whole lifetime - never in a module-level cache shared by plain fetch handlers.
 * `createDriverDataSource` therefore returns a fresh holder; the caller (the
 * agent) keeps it as an instance field.
 */
import { MongoClient, type Document } from "mongodb";
import type { DataSource } from "./types";

export function createDriverDataSource(uri: string, dbName: string): DataSource {
  let client: MongoClient | null = null;
  let connecting: Promise<MongoClient> | null = null;

  const getClient = (): Promise<MongoClient> => {
    if (client) return Promise.resolve(client);
    if (!connecting) {
      const c = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        maxPoolSize: 2,
        minPoolSize: 0,
      });
      connecting = c.connect().then((cc) => (client = cc)).finally(() => (connecting = null));
    }
    return connecting;
  };

  return {
    mode: "driver",
    async aggregate<T extends Document = Document>(collection: string, pipeline: Document[]): Promise<T[]> {
      const c = await getClient();
      return c.db(dbName).collection(collection).aggregate<T>(pipeline).toArray();
    },

    async updateMany(collection: string, filter: Document, update: Document) {
      const c = await getClient();
      const r = await c.db(dbName).collection(collection).updateMany(filter, update);
      return { matched: r.matchedCount, modified: r.modifiedCount };
    },

    async insertOne(collection: string, doc: Document): Promise<void> {
      const c = await getClient();
      await c.db(dbName).collection(collection).insertOne(doc);
    },
  };
}
