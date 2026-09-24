/**
 * Phase 0 -> MongoDB importer.
 *
 * Uses the mongodb driver rather than `mongoimport`, which ships separately in
 * MongoDB Database Tools and is not installed here.
 *
 * The one thing that matters: parse with EJSON, not JSON. `JSON.parse` leaves
 * {"$date": "..."} as a plain object, so every date lands as a sub-document and
 * every $dateTrunc / range query in Phase 1 silently returns nothing. EJSON.parse
 * turns it into a real BSON Date. The script verifies this before declaring success.
 *
 *   node import_data.mjs <dataDir> [mongoUri] [dbName]
 */
import { MongoClient } from "mongodb";
import { EJSON } from "bson";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const DATA_DIR = process.argv[2];
const URI      = process.argv[3] || process.env.MONGODB_URI || "mongodb://localhost:27017/";
const DB_NAME  = process.argv[4] || process.env.MONGODB_DB_NAME || "leadpulse";

if (!DATA_DIR) {
  console.error("usage: node import_data.mjs <dataDir> [mongoUri] [dbName]");
  process.exit(1);
}

const COLLECTIONS = ["leads", "activities", "channel_spend", "reps"];
const BATCH = 2000;

const INDEXES = {
  leads: [
    [{ created_at: 1 }, {}],
    [{ lead_source: 1, created_at: 1 }, {}],
    [{ owner_id: 1, created_at: 1 }, {}],
    [{ stage: 1, is_open: 1 }, {}],
    [{ converted: 1, converted_at: 1 }, {}],
    [{ lead_origin: 1, created_at: 1 }, {}],
  ],
  activities: [
    [{ lead_number: 1, ts: 1 }, {}],
    [{ ts: 1, actor: 1 }, {}],
  ],
  channel_spend: [[{ day: 1, channel: 1 }, { unique: true }]],
  reps: [[{ team: 1 }, {}]],
};

async function importFile(db, name) {
  const file = path.join(DATA_DIR, `${name}.jsonl`);
  const col = db.collection(name);
  await col.drop().catch(() => {});          // idempotent re-runs

  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let buf = [], n = 0, lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      buf.push(EJSON.parse(line));           // <-- EJSON, not JSON
    } catch (e) {
      throw new Error(`${name}.jsonl line ${lineNo}: ${e.message}`);
    }
    if (buf.length >= BATCH) {
      await col.insertMany(buf, { ordered: false });
      n += buf.length; buf = [];
      process.stdout.write(`\r  ${name}: ${n.toLocaleString()}`);
    }
  }
  if (buf.length) { await col.insertMany(buf, { ordered: false }); n += buf.length; }
  process.stdout.write(`\r  ${name}: ${n.toLocaleString()} docs\n`);
  return n;
}

const client = new MongoClient(URI);
try {
  await client.connect();
  const db = client.db(DB_NAME);
  console.log(`importing into "${DB_NAME}" at ${URI.replace(/\/\/[^@]*@/, "//***@")}\n`);

  const counts = {};
  for (const c of COLLECTIONS) counts[c] = await importFile(db, c);

  console.log("\ncreating indexes");
  for (const [c, specs] of Object.entries(INDEXES))
    for (const [keys, opts] of specs) {
      const nm = await db.collection(c).createIndex(keys, opts);
      console.log(`  ${c}.${nm}`);
    }

  // ---- verify ---------------------------------------------------------------
  console.log("\nverifying");
  const fails = [];
  const ck = (cond, msg) => cond ? console.log("  ok   " + msg) : fails.push(msg);

  const t = await db.collection("leads").aggregate([
    { $limit: 1 }, { $project: { ct: { $type: "$created_at" } } },
  ]).next();
  ck(t?.ct === "date", `leads.created_at is BSON date (got "${t?.ct}")`);

  const ta = await db.collection("activities").aggregate([
    { $limit: 1 }, { $project: { tt: { $type: "$ts" } } },
  ]).next();
  ck(ta?.tt === "date", `activities.ts is BSON date (got "${ta?.tt}")`);

  ck(counts.leads === 9239, `leads count ${counts.leads}`);
  const won = await db.collection("leads").countDocuments({ converted: true });
  ck(won === 3561, `converted ${won}`);

  // a real time-bucketed aggregation - the thing Phase 1 depends on
  const wk = await db.collection("leads").aggregate([
    { $match: { lead_source: "Olark Chat" } },
    { $group: {
        _id: { $dateTrunc: { date: "$created_at", unit: "week" } },
        leads: { $sum: 1 }, won: { $sum: { $cond: ["$converted", 1, 0] } } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  ck(wk.length > 50, `weekly $dateTrunc returns ${wk.length} buckets`);

  const rng = await db.collection("leads").aggregate([
    { $group: { _id: null, min: { $min: "$created_at" }, max: { $max: "$created_at" } } },
  ]).next();
  console.log(`  range ${rng.min.toISOString().slice(0,10)} -> ${rng.max.toISOString().slice(0,10)}`);

  if (fails.length) { console.error("\nFAILED:\n" + fails.map(f => "  " + f).join("\n")); process.exit(1); }
  console.log("\nimport complete");
} finally {
  await client.close();
}
