/**
 * The Watchtower eval, against the real database.
 *
 * Two halves, and the second matters more:
 *
 *  1. **Recall** - does it find the planted incidents?
 *  2. **Restraint** - does it stay quiet otherwise? A detector that flags
 *     everything is one nobody keeps enabled, which is why the foundry plants a
 *     benign festive dip and why the background rate is asserted, not assumed.
 *
 * Detection time is detector-dependent and that is stated rather than hidden.
 * Volume faults are visible the next morning; conversion and efficiency faults
 * read a window lagged by `MATURATION_DAYS`, so they surface about three weeks
 * later. You cannot know a lead failed to convert until it has had time to.
 */
import { afterAll, describe, expect, it } from "vitest";
import { MongoClient, type Document } from "mongodb";
import { readFileSync } from "node:fs";
import type { DataSource } from "../../db/types";
import { readOnlyFrom } from "../../db/readonly";
import { scan } from "../scan";
import { MATURATION_DAYS } from "../../semantic/metrics";
import type { Finding } from "../findings";

const URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/";
const DB = process.env.MONGODB_DB_NAME ?? "leadpulse";
const DATA_START = "2025-07-24";
const DAY = 86_400_000;

interface Incident {
  id: string;
  segment: { lead_source?: string; lead_origin?: string };
  start: string;
  end: string;
  should_alert: boolean;
}

const manifest = JSON.parse(readFileSync("data/foundry/_manifest.json", "utf8")) as {
  incidents: Incident[];
};
const incident = (id: string) => manifest.incidents.find((i) => i.id === id)!;

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

const scanAt = (isoDay: string) =>
  scan(ds, { asOf: new Date(`${isoDay}T06:00:00.000Z`), dataStart: DATA_START });

/** Volume faults are visible the morning after. */
const scanNextMorning = (inc: Incident) => scanAt(shift(inc.end, 1));
/** Outcome faults need the cohort to mature first. */
const scanAfterMaturity = (inc: Incident) => scanAt(shift(inc.end, MATURATION_DAYS + 1));

function shift(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

const incidents = (f: Finding[]) => f.filter((x) => x.kind === "incident");
const marketShifts = (f: Finding[]) => f.filter((x) => x.kind === "market_shift");

function show(findings: Finding[]): string {
  return findings.length === 0
    ? "(nothing)"
    : findings
        .map((f) => `${f.kind}/${f.detector}/${f.member ?? "all"} eff=${f.effect.toFixed(2)} p=${f.p.toExponential(1)}`)
        .join(" | ");
}

describe.skipIf(!reachable)("recall: the planted incidents are found", () => {
  it("landing_page_outage - a volume collapse on one origin, next morning", async () => {
    const inc = incident("landing_page_outage");
    const found = incidents((await scanNextMorning(inc)).findings);
    const hit = found.find((f) => f.detector === "volume" && f.member === "Landing Page Submission");
    expect(hit, show(found)).toBeDefined();
    expect(hit!.direction).toBe("drop");
    expect(hit!.effect).toBeLessThan(0.7);
    // It is the largest thing on the feed, not buried in it.
    expect(found[0]!.member).toBe("Landing Page Submission");
  }, 60_000);

  it("reference_surge - a volume surge on one source, next morning", async () => {
    const inc = incident("reference_surge");
    const found = incidents((await scanNextMorning(inc)).findings);
    const hit = found.find((f) => f.detector === "volume" && f.member === "Reference");
    expect(hit, show(found)).toBeDefined();
    expect(hit!.direction).toBe("surge");
    expect(hit!.effect).toBeGreaterThan(1.5);
  }, 60_000);

  it("olark_conversion_collapse - conversion falls, volume holds", async () => {
    const inc = incident("olark_conversion_collapse");
    const found = incidents((await scanAfterMaturity(inc)).findings);
    const hit = found.find((f) => f.detector === "conversion" && f.member === "Olark Chat");
    expect(hit, show(found)).toBeDefined();
    expect(hit!.direction).toBe("drop");
    expect(hit!.effect).toBeLessThan(0.6);
    // The signature of a routing fault: no volume finding on the same segment.
    expect(found.some((f) => f.detector === "volume" && f.member === "Olark Chat")).toBe(false);
  }, 60_000);

  it("google_spend_waste - the money stopped buying conversions", async () => {
    const inc = incident("google_spend_waste");
    const found = incidents((await scanAfterMaturity(inc)).findings);
    const hit = found.find((f) => f.detector === "efficiency" && f.member === "Google");
    expect(hit, show(found)).toBeDefined();
    expect(hit!.direction).toBe("drop");
    // CAC roughly tripled; the manifest measures 656 -> 1,811.
    expect(1 / hit!.effect).toBeGreaterThan(2);
    expect(found[0]!.member).toBe("Google");
  }, 60_000);

  it("reports improvements, not only regressions", async () => {
    // reference_surge is a *good* outcome and is still raised - a detector that
    // only reports bad news hides half the story.
    const found = incidents((await scanNextMorning(incident("reference_surge"))).findings);
    expect(found.some((f) => f.direction === "surge")).toBe(true);
  }, 60_000);
});

describe.skipIf(!reachable)("a documented miss: seo_content_revamp is below detection power", () => {
  /**
   * The manifest marks this one `should_alert`, and the detector does not find
   * it. That is a measured limit, not an oversight, and it is pinned here so
   * that a future change in sensitivity shows up as a failing test rather than
   * as a surprise.
   *
   * Organic Search runs about three leads a day. A 1.59x conversion lift over
   * 17 days is roughly nine extra conversions. Against a baseline carrying its
   * own sampling noise, the best two-sided p-value across every window length
   * and every maturation horizon tested was 0.064 - and that was with an
   * unbounded horizon and a window aligned by hand. Under false-discovery
   * control across ~50 cells it cannot clear the bar. Detecting it would mean
   * an operating point that also raises several findings a week on quiet data.
   */
  it("is not raised, at either detection time", async () => {
    const inc = incident("seo_content_revamp");
    for (const report of [await scanNextMorning(inc), await scanAfterMaturity(inc)]) {
      const hit = incidents(report.findings).find(
        (f) => f.detector === "conversion" && f.member === "Organic Search",
      );
      expect(hit, "sensitivity improved - revisit the documented miss").toBeUndefined();
    }
  }, 60_000);
});

describe.skipIf(!reachable)("restraint: the benign dip raises nothing", () => {
  const lull = incident("festive_lull");

  it("raises no incident during the festive lull", async () => {
    for (const report of [await scanNextMorning(lull), await scanAfterMaturity(lull)]) {
      expect(incidents(report.findings), show(report.findings)).toHaveLength(0);
    }
  }, 60_000);

  it("still reports it, as a market shift rather than a fault", async () => {
    const report = await scanNextMorning(lull);
    const market = marketShifts(report.findings);
    expect(market.some((f) => f.detector === "volume" && f.direction === "drop")).toBe(true);
    expect(market[0]!.headline).toMatch(/whole pipeline/);
  }, 60_000);
});

describe.skipIf(!reachable)("restraint: the background rate on quiet data", () => {
  /**
   * 2025-12-23 to 2026-02-08 is the only run of dates where no planted incident
   * falls inside any window a scan can see - volume looks back 28 days,
   * outcomes 28 plus the maturation lag.
   */
  it("stays silent on most days, and never floods", async () => {
    let scans = 0;
    let firings = 0;
    let silent = 0;
    let worst = 0;

    for (let t = Date.parse("2025-12-23T00:00:00Z"); t <= Date.parse("2026-02-08T00:00:00Z"); t += DAY) {
      const report = await scan(ds, { asOf: new Date(t), dataStart: DATA_START });
      const n = incidents(report.findings).length;
      scans++;
      firings += n;
      if (n === 0) silent++;
      worst = Math.max(worst, n);
    }

    // Measured at the time of writing: 0.17 findings per scan, 42 of 48 scans
    // silent, never more than 2 at once. The bounds below leave room for the
    // data to be regenerated with a different seed.
    expect(firings / scans, `${firings} findings over ${scans} scans`).toBeLessThan(0.5);
    expect(silent / scans).toBeGreaterThan(0.75);
    expect(worst).toBeLessThanOrEqual(3);
  }, 300_000);
});

describe.skipIf(!reachable)("the sweep is well-formed", () => {
  it("tests a useful number of cells and skips the underpowered ones", async () => {
    const report = await scanAt("2026-06-29");
    expect(report.stats.testsRun).toBeGreaterThan(30);
    expect(report.stats.testsSkipped).toBeGreaterThan(0);
  }, 60_000);

  it("is deterministic", async () => {
    const [a, b] = [await scanAt("2026-06-29"), await scanAt("2026-06-29")];
    expect(a.findings.map((f) => f.key)).toEqual(b.findings.map((f) => f.key));
    expect(a.findings.map((f) => f.p)).toEqual(b.findings.map((f) => f.p));
  }, 60_000);

  it("never reads into the partial current day", async () => {
    const report = await scan(ds, {
      asOf: new Date("2026-06-29T23:59:00.000Z"),
      dataStart: DATA_START,
    });
    const latest = report.stats.windows.map((w) => w.window.to).sort().at(-1);
    expect(latest).toBe("2026-06-28");
  }, 60_000);

  it("lags the outcome detectors behind the volume ones", async () => {
    const report = await scanAt("2026-06-29");
    const ends = [...new Set(report.stats.windows.map((w) => w.window.to))].sort();
    expect(ends).toContain("2026-06-28");
    expect(ends).toContain(shift("2026-06-28", -MATURATION_DAYS));
  }, 60_000);

  it("never lets a baseline run off the start of the data", async () => {
    const report = await scanAt("2025-09-20");
    for (const w of report.stats.windows) expect(w.baseline.from >= DATA_START).toBe(true);
  }, 60_000);

  it("ranks by business impact, not by p-value", async () => {
    const report = await scanAt(shift(incident("landing_page_outage").end, 1));
    const impacts = report.findings.map((f) => f.impactUnits);
    expect([...impacts].sort((a, b) => b - a)).toEqual(impacts);
  }, 60_000);
});
