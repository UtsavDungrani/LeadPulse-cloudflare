/**
 * The write path, against a real database.
 *
 * Runs in a **scratch database of its own**, seeded and dropped by this file.
 * The `leadpulse` dataset is the answer key for every other eval in the project
 * and nothing here is allowed near it - a write test that mutates the fixture
 * it is measured against is a test that silently invalidates its neighbours.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Document } from "mongodb";
import type { DataSource } from "../../db/types";
import { readOnly, ReadOnlyViolation } from "../../db/readonly";
import { validateAction, type ActionIntent } from "../actions";
import { apply, AUDIT_COLLECTION, findAudit, preview, recentAudit, undo } from "../apply";

const URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/";
const DB = "leadpulse_desk_test";

let client: MongoClient | null = null;
const reachable = await (async () => {
  try {
    const c = new MongoClient(URI, { serverSelectionTimeoutMS: 1500 });
    await c.connect();
    await c.db(DB).command({ ping: 1 });
    client = c;
    return true;
  } catch {
    return false;
  }
})();

const ds: DataSource = {
  mode: "driver",
  async aggregate(collection, pipeline) {
    return (await client!.db(DB).collection(collection).aggregate(pipeline).toArray()) as never;
  },
  async updateMany(collection, filter, update) {
    const r = await client!.db(DB).collection(collection).updateMany(filter, update);
    return { matched: r.matchedCount, modified: r.modifiedCount };
  },
  async insertOne(collection, doc) {
    await client!.db(DB).collection(collection).insertOne(doc as never);
  },
};

/** 20 leads: 10 Olark (2 converted), 10 Google, all created in June 2026. */
function seed(): Document[] {
  return Array.from({ length: 20 }, (_, i) => {
    const olark = i < 10;
    const converted = olark && i < 2;
    return {
      _id: `lead-${i}`,
      lead_number: 900_000 + i,
      created_at: new Date(Date.UTC(2026, 5, 5 + (i % 20))),
      converted,
      converted_at: converted ? new Date(Date.UTC(2026, 5, 20)) : null,
      days_to_convert: converted ? 15 : null,
      stage: converted ? "Won" : i % 3 === 0 ? "New" : "Engaged",
      is_open: !converted,
      owner_id: i % 2 === 0 ? "REP001" : "REP002",
      lead_source: olark ? "Olark Chat" : "Google",
      lead_origin: "API",
      consent: { do_not_email: false, do_not_call: false, wants_free_copy: false },
      sla: { first_response_minutes: 30, breached: false },
    };
  });
}

beforeAll(async () => {
  if (!reachable) return;
  await client!.db(DB).dropDatabase();
});

beforeEach(async () => {
  if (!reachable) return;
  await client!.db(DB).collection("leads").deleteMany({});
  await client!.db(DB).collection(AUDIT_COLLECTION).deleteMany({});
  await client!.db(DB).collection("leads").insertMany(seed() as never[]);
});

afterAll(async () => {
  if (client) await client.db(DB).dropDatabase();
  await client?.close();
});

const intent = (patch: Record<string, unknown> = {}): ActionIntent =>
  validateAction({
    action: "reassign_owner",
    filters: [{ field: "lead_source", op: "eq", values: ["Olark Chat"] }],
    dateRange: { from: "2026-06-01", to: "2026-06-30" },
    value: "REP007",
    reason: "Olark leads need the chat-trained rep",
    limit: 50,
    ...patch,
  });

const ownerCount = async (owner: string) =>
  ((await ds.aggregate("leads", [{ $match: { owner_id: owner } }, { $count: "n" }]))[0]?.n as number) ?? 0;

describe.skipIf(!reachable)("preview does not write", () => {
  it("reports the real count and a sample without touching anything", async () => {
    const before = await ownerCount("REP007");
    const p = await preview(ds, intent());
    expect(p.matched).toBe(10);
    expect(p.sample).toHaveLength(5);
    expect(p.blocked).toBeNull();
    expect(await ownerCount("REP007")).toBe(before);
  });

  it("shows what is being overwritten", async () => {
    const p = await preview(ds, intent());
    expect(p.currentValues.map((c) => c.value).sort()).toEqual(["REP001", "REP002"]);
    expect(p.currentValues.reduce((a, c) => a + c.count, 0)).toBe(10);
  });

  it("returns the exact filter and update, not a description of them", async () => {
    const p = await preview(ds, intent());
    expect(p.compiled.update).toEqual({ $set: { owner_id: "REP007" } });
    expect(p.compiled.filter.$and).toEqual([{ lead_source: "Olark Chat" }]);
  });

  it("blocks a proposal that matches more leads than its own limit", async () => {
    const p = await preview(ds, intent({ limit: 5 }));
    expect(p.blocked).toMatch(/more than the proposal's limit/);
  });

  it("blocks a proposal that matches nothing", async () => {
    const p = await preview(ds, intent({ filters: [{ field: "lead_source", op: "eq", values: ["Bing"] }] }));
    expect(p.blocked).toMatch(/nothing to change/);
  });

  it("blocks a proposal that would change nothing", async () => {
    await apply(ds, intent(), "prop_1", 10);
    const p = await preview(ds, intent());
    expect(p.alreadyCorrect).toBe(10);
    expect(p.blocked).toMatch(/already holds this value/);
  });
});

describe.skipIf(!reachable)("apply writes exactly what was previewed", () => {
  it("moves the matched leads and nothing else", async () => {
    const p = await preview(ds, intent());
    const audit = await apply(ds, p.intent, p.proposalId, p.matched);
    expect(audit.matched).toBe(10);
    expect(audit.modified).toBe(10);
    expect(await ownerCount("REP007")).toBe(10);
    // The Google leads are untouched.
    const google = await ds.aggregate("leads", [
      { $match: { lead_source: "Google", owner_id: "REP007" } },
      { $count: "n" },
    ]);
    expect(google[0]?.n ?? 0).toBe(0);
  });

  it("refuses when the data moved between preview and approval", async () => {
    const p = await preview(ds, intent());
    // Somebody else adds a matching lead in the meantime.
    await client!.db(DB).collection("leads").insertOne({
      ...seed()[0],
      _id: "lead-late",
      owner_id: "REP003",
    } as never);
    await expect(apply(ds, p.intent, p.proposalId, p.matched)).rejects.toThrow(
      /the data changed since the preview/,
    );
    expect(await ownerCount("REP007")).toBe(0);
  });

  it("never changes a converted lead's stage", async () => {
    const p = await preview(ds, intent({ action: "set_stage", value: "Attempting" }));
    // Ten Olark leads, two of them converted; only the eight open ones match.
    expect(p.matched).toBe(8);
    await apply(ds, p.intent, p.proposalId, p.matched);
    const won = await ds.aggregate("leads", [{ $match: { stage: "Won" } }, { $count: "n" }]);
    expect(won[0]?.n).toBe(2);
  });

  it("keeps is_open consistent with the stage it wrote", async () => {
    const p = await preview(ds, intent({ action: "set_stage", value: "Lost" }));
    await apply(ds, p.intent, p.proposalId, p.matched);
    const inconsistent = await ds.aggregate("leads", [
      { $match: { stage: "Lost", is_open: true } },
      { $count: "n" },
    ]);
    expect(inconsistent[0]?.n ?? 0).toBe(0);
  });

  it("writes an audit record carrying the exact query and write", async () => {
    const p = await preview(ds, intent());
    const audit = await apply(ds, p.intent, p.proposalId, p.matched);
    const stored = await findAudit(ds, audit._id);
    expect(stored!.reason).toBe("Olark leads need the chat-trained rep");
    expect(stored!.update).toEqual({ $set: { owner_id: "REP007" } });
    expect(stored!.before).toHaveLength(10);
    expect(await recentAudit(ds)).toHaveLength(1);
  });
});

describe.skipIf(!reachable)("undo", () => {
  it("restores every lead to the value it actually held", async () => {
    const beforeByOwner = {
      REP001: await ownerCount("REP001"),
      REP002: await ownerCount("REP002"),
    };
    const p = await preview(ds, intent());
    const audit = await apply(ds, p.intent, p.proposalId, p.matched);
    expect(await ownerCount("REP007")).toBe(10);

    await undo(ds, (await findAudit(ds, audit._id))!);

    expect(await ownerCount("REP007")).toBe(0);
    expect(await ownerCount("REP001")).toBe(beforeByOwner.REP001);
    expect(await ownerCount("REP002")).toBe(beforeByOwner.REP002);
  });

  it("restores both fields of a stage change", async () => {
    const p = await preview(ds, intent({ action: "set_stage", value: "Lost" }));
    const audit = await apply(ds, p.intent, p.proposalId, p.matched);
    await undo(ds, (await findAudit(ds, audit._id))!);

    const stages = await ds.aggregate("leads", [
      { $group: { _id: "$stage", n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    expect(stages.map((s) => [s._id, s.n])).toEqual([
      ["Engaged", 12],
      ["New", 6],
      ["Won", 2],
    ]);
    const openWon = await ds.aggregate("leads", [
      { $match: { stage: "Won", is_open: true } },
      { $count: "n" },
    ]);
    expect(openWon[0]?.n ?? 0).toBe(0);
  });

  it("is itself audited", async () => {
    const p = await preview(ds, intent());
    const audit = await apply(ds, p.intent, p.proposalId, p.matched);
    const reversal = await undo(ds, (await findAudit(ds, audit._id))!);
    expect(reversal.undoOf).toBe(audit._id);
    expect(await recentAudit(ds)).toHaveLength(2);
  });

  it("refuses to undo the same change twice", async () => {
    const p = await preview(ds, intent());
    const audit = await apply(ds, p.intent, p.proposalId, p.matched);
    const record = (await findAudit(ds, audit._id))!;
    await undo(ds, record);
    await expect(undo(ds, record)).rejects.toThrow(/already been undone/);
  });
});

describe.skipIf(!reachable)("the read agents cannot write at all", () => {
  it("throws rather than writing, wherever the call came from", async () => {
    const guarded = readOnly(ds);
    expect(() => guarded.updateMany("leads", {}, { $set: { owner_id: "REP001" } })).toThrow(
      ReadOnlyViolation,
    );
    expect(() => guarded.insertOne("leads", {})).toThrow(ReadOnlyViolation);
    // And reads still work.
    expect((await guarded.aggregate("leads", [{ $count: "n" }]))[0]?.n).toBe(20);
  });
});
