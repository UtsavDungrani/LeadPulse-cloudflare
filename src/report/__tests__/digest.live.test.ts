/**
 * The digest, against the real database. Read-only throughout.
 *
 * The property worth testing is not the prose - it is that the two blocks
 * describe two different windows and say which. A digest whose conversion rate
 * silently refers to an unresolved cohort is wrong in a way no reader can see.
 */
import { afterAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import type { DataSource } from "../../db/types";
import { readOnlyFrom } from "../../db/readonly";
import { buildDigest } from "../digest";
import { deliver, resolveSink } from "../deliver";
import { MATURATION_DAYS } from "../../semantic/metrics";

const URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/";
const DB = process.env.MONGODB_DB_NAME ?? "leadpulse";

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

afterAll(async () => {
  await client?.close();
});

const ds: DataSource = readOnlyFrom((collection, pipeline) =>
  client!.db(DB).collection(collection).aggregate(pipeline).toArray(),
);

const ASOF = new Date("2026-09-24T08:00:00.000Z");

describe.skipIf(!reachable)("buildDigest", () => {
  it("reports the week that ended yesterday", async () => {
    const d = await buildDigest(ds, { asOf: ASOF });
    expect(d.period).toEqual({ from: "2026-09-17", to: "2026-09-23" });
    expect(d.priorPeriod).toEqual({ from: "2026-09-10", to: "2026-09-16" });
  });

  it("puts outcome metrics on a cohort that has had time to resolve", async () => {
    const d = await buildDigest(ds, { asOf: ASOF });
    expect(d.maturedPeriod.to).toBe("2026-09-02");
    // Exactly MATURATION_DAYS behind the live block, not an arbitrary offset.
    const gap =
      (Date.parse(`${d.period.to}T00:00:00Z`) - Date.parse(`${d.maturedPeriod.to}T00:00:00Z`)) /
      86_400_000;
    expect(gap).toBe(MATURATION_DAYS);
  });

  it("keeps conversion out of the live block entirely", async () => {
    const d = await buildDigest(ds, { asOf: ASOF });
    expect(d.thisPeriod.map((m) => m.id)).not.toContain("conversion_rate");
    expect(d.thisPeriod.map((m) => m.id)).not.toContain("conversion_rate_21d");
    expect(d.maturedCohort.map((m) => m.id)).toContain("conversion_rate_21d");
  });

  it("names the matured window in the rendered digest", async () => {
    const d = await buildDigest(ds, { asOf: ASOF });
    expect(d.markdown).toContain(`Matured cohort (${d.maturedPeriod.from} to ${d.maturedPeriod.to})`);
    expect(d.markdown).toContain(`${MATURATION_DAYS} days to convert`);
  });

  it("phrases a change by whether it is good, not by its sign", async () => {
    const d = await buildDigest(ds, { asOf: ASOF });
    // SLA breach rate is lower-is-better; a rise must read as worse.
    const sla = d.thisPeriod.find((m) => m.id === "sla_breach_rate")!;
    expect(sla.higherIsBetter).toBe(false);
    if (sla.changePct !== null && sla.changePct > 1) {
      expect(d.markdown).toMatch(/up \d+% — worse/);
    }
  });

  it("always has a summary, with or without a model", async () => {
    const d = await buildDigest(ds, { asOf: ASOF });
    expect(d.summarySource).toBe("computed");
    expect(d.summary.length).toBeGreaterThan(40);
    expect(d.summary).toMatch(/leads this period/);
  });

  it("sums channel shares to one", async () => {
    const d = await buildDigest(ds, { asOf: ASOF });
    expect(d.channels.length).toBeGreaterThan(0);
    expect(d.channels.reduce((a, c) => a + c.share, 0)).toBeCloseTo(1, 6);
  });

  it("says when the findings were last swept", async () => {
    const withFindings = await buildDigest(ds, {
      asOf: ASOF,
      findings: [
        { key: "k", kind: "incident", status: "new", headline: "Something", impact: "10 leads fewer" },
      ],
      findingsAsOf: "2026-09-24T07:00:00.000Z",
    });
    expect(withFindings.markdown).toContain("Last swept 2026-09-24 07:00 UTC");
    const without = await buildDigest(ds, { asOf: ASOF });
    expect(without.markdown).toContain("Never swept");
  });
});

describe("delivery is off unless configured", () => {
  it("defaults to holding the digest", async () => {
    expect(resolveSink({})).toBe("none");
    const result = await deliver({ markdown: "x" } as never, {});
    expect(result.delivered).toBe(false);
    expect(result.detail).toMatch(/Held/);
  });

  it("does not post anywhere when the sink is set but no url is", async () => {
    const result = await deliver({ markdown: "x" } as never, { REPORT_SINK: "webhook" });
    expect(result.delivered).toBe(false);
    expect(result.detail).toMatch(/REPORT_WEBHOOK_URL is not set/);
  });

  it("refuses a plaintext endpoint - a digest carries rep names and spend", async () => {
    const result = await deliver({ markdown: "x" } as never, {
      REPORT_SINK: "webhook",
      REPORT_WEBHOOK_URL: "http://example.invalid/hook",
    });
    expect(result.delivered).toBe(false);
    expect(result.detail).toMatch(/must be https/);
  });
});
