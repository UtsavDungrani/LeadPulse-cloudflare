/**
 * Integration tests against the real database, using `data/foundry/_manifest.json`
 * as the answer key.
 *
 * The manifest records both what the foundry *asked* for (`planted`) and what
 * the data *contains* (`measured`). These assert against `measured` - the two
 * diverge whenever a segment saturates or a window is short, and asserting
 * against `planted` means debugging a correct agent against a wrong key.
 *
 * Skipped automatically when Mongo is not running, so `npm test` still passes
 * on a fresh checkout.
 */
import { afterAll, describe, expect, it } from "vitest";
import { MongoClient, type Document } from "mongodb";
import { readFileSync } from "node:fs";
import type { DataSource } from "../../db/types";
import { execute } from "../execute";
import { validateIntent, type QueryIntent } from "../intent";
import type { FieldId } from "../fields";

const URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/";
const DB = process.env.MONGODB_DB_NAME ?? "leadpulse";

interface Incident {
  id: string;
  segment: { lead_source?: string; lead_origin?: string };
  start: string;
  end: string;
  should_alert: boolean;
  measured: {
    window_days: number;
    leads_in_window: number;
    volume_per_day: { baseline: number; window: number; ratio: number };
    conversion_rate: { baseline: number; window: number; ratio: number };
    spend_per_day?: { window: number; ratio: number };
    cac_inr?: { baseline: number; window: number; ratio: number };
  };
}

const manifest = JSON.parse(readFileSync("data/foundry/_manifest.json", "utf8")) as {
  counts: Record<string, number>;
  incidents: Incident[];
};

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

const ds: DataSource = {
  mode: "driver",
  async aggregate(collection: string, pipeline: Document[]) {
    return (await client!.db(DB).collection(collection).aggregate(pipeline).toArray()) as never;
  },
};

const intent = (patch: Partial<QueryIntent>): QueryIntent =>
  validateIntent({
    metric: "leads_created",
    grain: "total",
    dateRange: { from: "2026-06-01", to: "2026-06-30" },
    dimensions: [],
    filters: [],
    compareTo: "none",
    limit: 10,
    ...patch,
  });

/** Turn an incident's segment into the filter the semantic layer speaks. */
function segmentFilters(inc: Incident): QueryIntent["filters"] {
  return Object.entries(inc.segment).map(([field, value]) => ({
    field: field as FieldId,
    op: "eq" as const,
    values: [String(value)],
  }));
}

describe.skipIf(!reachable)("the data is what the manifest says it is", () => {
  it("has the documented collection counts", async () => {
    for (const [collection, expected] of Object.entries(manifest.counts)) {
      if (collection === "converted") continue;
      const [row] = await ds.aggregate(collection, [{ $count: "n" }]);
      expect(row?.n, collection).toBe(expected);
    }
  });

  it("stores created_at as a BSON date, not an Extended JSON sub-document", async () => {
    // The failure this guards against is silent: `$dateTrunc` returns nothing
    // and every time-based query looks like a logic bug.
    const [row] = await ds.aggregate("leads", [
      { $limit: 1 },
      { $project: { t: { $type: "$created_at" } } },
    ]);
    expect(row?.t).toBe("date");
  });
});

describe.skipIf(!reachable)("planted incidents reproduce through the semantic layer", () => {
  for (const inc of manifest.incidents) {
    describe(inc.id, () => {
      const dateRange = { from: inc.start, to: inc.end };
      const filters = segmentFilters(inc);

      it("counts the documented number of leads in the window", async () => {
        const result = await execute(ds, intent({ metric: "leads_created", dateRange, filters }));
        expect(result.total?.value).toBe(inc.measured.leads_in_window);
      });

      it("reproduces the measured conversion rate", async () => {
        const result = await execute(ds, intent({ metric: "conversion_rate", dateRange, filters }));
        expect(result.total?.value).toBeCloseTo(inc.measured.conversion_rate.window, 4);
      });

      it("reproduces the measured volume per day", async () => {
        const result = await execute(ds, intent({ metric: "leads_created", dateRange, filters }));
        const perDay = (result.total?.value ?? 0) / inc.measured.window_days;
        expect(perDay).toBeCloseTo(inc.measured.volume_per_day.window, 2);
      });
    });
  }
});

describe.skipIf(!reachable)("the Olark collapse is visible weekly", () => {
  const olark = manifest.incidents.find((i) => i.id === "olark_conversion_collapse")!;

  it("shows conversion falling while volume holds - the signature of a routing fault", async () => {
    const result = await execute(
      ds,
      intent({
        metric: "conversion_rate",
        grain: "week",
        dateRange: { from: "2026-04-01", to: "2026-07-15" },
        filters: [{ field: "lead_source", op: "eq", values: ["Olark Chat"] }],
      }),
    );

    const inWindow = (p: string | null) => p !== null && p >= "2026-06-08" && p <= "2026-06-28";
    const during = result.rows.filter((r) => inWindow(r.period) && r.value !== null);
    const before = result.rows.filter((r) => !inWindow(r.period) && r.value !== null);

    expect(during.length).toBeGreaterThanOrEqual(2);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const rateDuring = mean(during.map((r) => r.value!));
    const rateBefore = mean(before.map((r) => r.value!));
    expect(rateDuring).toBeLessThan(rateBefore * 0.5);

    // Volume is flat - this is a conversion fault, not a traffic fault.
    const volDuring = mean(during.map((r) => r.support.n ?? 0));
    const volBefore = mean(before.map((r) => r.support.n ?? 0));
    expect(volDuring / volBefore).toBeGreaterThan(0.7);
    expect(volDuring / volBefore).toBeLessThan(1.4);
  });

  it("reports the drop as a ratio close to the manifest when compared to the prior period", async () => {
    const result = await execute(
      ds,
      intent({
        metric: "conversion_rate",
        dateRange: { from: olark.start, to: olark.end },
        filters: [{ field: "lead_source", op: "eq", values: ["Olark Chat"] }],
        compareTo: "previous_period",
      }),
    );
    // The manifest baseline is a longer window than the 21 days immediately
    // before, so this checks the direction and the order of magnitude, not the
    // exact figure.
    expect(result.total?.comparison?.ratio).toBeLessThan(0.5);
  });
});

describe.skipIf(!reachable)("CAC reproduces the Google spend incident", () => {
  const inc = manifest.incidents.find((i) => i.id === "google_spend_waste")!;

  it("matches the measured CAC in the window", async () => {
    const result = await execute(
      ds,
      intent({
        metric: "cac",
        dateRange: { from: inc.start, to: inc.end },
        dimensions: ["channel"],
        filters: [{ field: "channel", op: "eq", values: ["Google"] }],
      }),
    );
    const google = result.rows.find((r) => r.dims.channel === "Google");
    expect(google?.value).toBeCloseTo(inc.measured.cac_inr!.window, 0);
  });

  it("matches the measured daily spend in the window", async () => {
    const result = await execute(
      ds,
      intent({
        metric: "cpl",
        dateRange: { from: inc.start, to: inc.end },
        dimensions: ["channel"],
        filters: [{ field: "channel", op: "eq", values: ["Google"] }],
      }),
    );
    const google = result.rows.find((r) => r.dims.channel === "Google");
    const perDay = (google?.support.spend ?? 0) / inc.measured.window_days;
    expect(perDay).toBeCloseTo(inc.measured.spend_per_day!.window, 0);
  });
});

describe.skipIf(!reachable)("metric definitions agree with each other", () => {
  const dateRange = { from: "2026-01-01", to: "2026-06-30" };

  it("conversion_rate equals conversions over leads created", async () => {
    const [rate, created, converted] = await Promise.all([
      execute(ds, intent({ metric: "conversion_rate", dateRange })),
      execute(ds, intent({ metric: "leads_created", dateRange })),
      execute(ds, intent({ metric: "leads_converted", dateRange })),
    ]);
    expect(rate.total!.value).toBeCloseTo(converted.total!.value! / created.total!.value!, 10);
  });

  it("splitting by a dimension preserves the total", async () => {
    const split = await execute(
      ds,
      intent({ metric: "leads_created", dateRange, dimensions: ["lead_source"], limit: 100 }),
    );
    const sum = split.rows.reduce((a, r) => a + (r.value ?? 0), 0);
    expect(sum).toBe(split.total!.value);
  });

  it("returns null rather than zero for a segment with no leads", async () => {
    const result = await execute(
      ds,
      intent({
        metric: "conversion_rate",
        dateRange: { from: "2026-06-01", to: "2026-06-02" },
        filters: [{ field: "city", op: "eq", values: ["Atlantis"] }],
      }),
    );
    expect(result.total).toBeNull();
    expect(result.rows).toHaveLength(0);
  });

  it("keeps the top-N series and says so", async () => {
    const result = await execute(
      ds,
      intent({ metric: "leads_created", grain: "month", dateRange, dimensions: ["lead_source"], limit: 3 }),
    );
    const series = new Set(result.rows.map((r) => r.dims.lead_source));
    expect(series.size).toBeLessThanOrEqual(3);
    expect(result.meta.notes.join(" ")).toMatch(/top 3/);
  });
});
