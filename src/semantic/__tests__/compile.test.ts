import { describe, expect, it } from "vitest";
import { compileQuery, compileRankingQuery, needsRanking, MAX_GROUPS } from "../compile";
import { validateIntent, IntentError, type QueryIntent } from "../intent";

const base: QueryIntent = {
  metric: "conversion_rate",
  grain: "week",
  dateRange: { from: "2026-06-01", to: "2026-06-30" },
  dimensions: [],
  filters: [],
  compareTo: "none",
  limit: 10,
};

const intent = (patch: Partial<QueryIntent> = {}): QueryIntent =>
  validateIntent({ ...base, ...patch });

describe("compileQuery", () => {
  it("emits the exact pipeline for a simple weekly series", () => {
    const { parts } = compileQuery(intent(), base.dateRange);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.collection).toBe("leads");
    expect(parts[0]!.pipeline).toEqual([
      {
        $match: {
          created_at: {
            $gte: new Date("2026-06-01T00:00:00.000Z"),
            $lt: new Date("2026-07-01T00:00:00.000Z"),
          },
        },
      },
      {
        $group: {
          _id: {
            period: { $dateTrunc: { date: "$created_at", unit: "week", startOfWeek: "monday" } },
          },
          n: { $sum: 1 },
          won: { $sum: { $cond: [{ $eq: ["$converted", true] }, 1, 0] } },
        },
      },
      { $sort: { "_id.period": 1 } },
      { $limit: MAX_GROUPS },
    ]);
  });

  it("makes the end of the range exclusive at the next midnight", () => {
    // An inclusive `$lte` on a day boundary silently drops everything that
    // happened after 00:00:00 on the last day.
    const { parts } = compileQuery(intent({ grain: "total" }), {
      from: "2026-06-08",
      to: "2026-06-08",
    });
    expect((parts[0]!.pipeline[0] as Record<string, any>).$match.created_at).toEqual({
      $gte: new Date("2026-06-08T00:00:00.000Z"),
      $lt: new Date("2026-06-09T00:00:00.000Z"),
    });
  });

  it("groups by dimension and drops the period when the grain is total", () => {
    const { parts } = compileQuery(
      intent({ grain: "total", dimensions: ["lead_source"] }),
      base.dateRange,
    );
    const group = (parts[0]!.pipeline[1] as Record<string, any>).$group;
    expect(group._id).toEqual({ d0: "$lead_source" });
  });

  it("uses _id: null when there is nothing to group by", () => {
    const { parts } = compileQuery(intent({ grain: "total" }), base.dateRange);
    expect((parts[0]!.pipeline[1] as Record<string, any>).$group._id).toBeNull();
  });

  it("coerces filter values against the declared field type", () => {
    const { parts } = compileQuery(
      intent({
        filters: [
          { field: "lead_source", op: "eq", values: ["Olark Chat"] },
          { field: "converted", op: "eq", values: ["true"] },
          { field: "total_visits", op: "gte", values: ["3"] },
        ],
      }),
      base.dateRange,
    );
    expect((parts[0]!.pipeline[0] as Record<string, any>).$match.$and).toEqual([
      { lead_source: "Olark Chat" },
      { converted: true },
      { "engagement.total_visits": { $gte: 3 } },
    ]);
  });

  it("merges the metric prefilter into the match", () => {
    const { parts } = compileQuery(
      intent({ metric: "avg_days_to_convert", grain: "total" }),
      base.dateRange,
    );
    expect((parts[0]!.pipeline[0] as Record<string, any>).$match.$and).toEqual([{ converted: true }]);
  });

  it("joins activities through a sub-pipeline so the lead_number index is used", () => {
    const { parts } = compileQuery(
      intent({ metric: "touches_to_convert", grain: "total" }),
      base.dateRange,
    );
    const lookup = (parts[0]!.pipeline[1] as Record<string, any>).$lookup;
    expect(lookup.from).toBe("activities");
    expect(lookup.localField).toBeUndefined();
    expect(lookup.pipeline).toEqual([
      { $match: { $expr: { $eq: ["$lead_number", "$$ln"] } } },
      { $count: "c" },
    ]);
  });

  it("compiles cac as two joinable parts, not a cross-collection lookup", () => {
    const { parts } = compileQuery(
      intent({ metric: "cac", grain: "month", dimensions: ["channel"] }),
      base.dateRange,
    );
    expect(parts.map((p) => [p.name, p.collection])).toEqual([
      ["spend", "channel_spend"],
      ["conversions", "leads"],
    ]);
    // Each side groups on its own name for the same concept.
    expect((parts[0]!.pipeline[1] as Record<string, any>).$group._id.d0).toBe("$channel");
    expect((parts[1]!.pipeline[1] as Record<string, any>).$group._id.d0).toBe("$lead_source");
  });

  it("restricts a follow-up query to the ranked members", () => {
    const { parts } = compileQuery(
      intent({ dimensions: ["lead_source"] }),
      base.dateRange,
      { restrictTo: { lead_source: ["Google", "Olark Chat"] } },
    );
    expect((parts[0]!.pipeline[0] as Record<string, any>).$match.$and).toEqual([
      { lead_source: { $in: ["Google", "Olark Chat"] } },
    ]);
  });

  it("forces grain total for the ranking pass", () => {
    const i = intent({ dimensions: ["lead_source"] });
    expect(needsRanking(i)).toBe(true);
    const { parts, grain } = compileRankingQuery(i, i.dateRange);
    expect(grain).toBe("total");
    expect((parts[0]!.pipeline[1] as Record<string, any>).$group._id).toEqual({ d0: "$lead_source" });
  });

  it("does not rank when there is nothing to rank", () => {
    expect(needsRanking(intent())).toBe(false);
    expect(needsRanking(intent({ grain: "total", dimensions: ["stage"] }))).toBe(false);
  });

  it("caps every pipeline at MAX_GROUPS", () => {
    const { parts } = compileQuery(intent({ grain: "day", dimensions: ["country"] }), base.dateRange);
    expect(parts[0]!.pipeline.at(-1)).toEqual({ $limit: MAX_GROUPS });
  });

  it("is pure - same intent, identical pipeline", () => {
    const a = compileQuery(intent({ dimensions: ["lead_source"] }), base.dateRange);
    const b = compileQuery(intent({ dimensions: ["lead_source"] }), base.dateRange);
    expect(JSON.stringify(a.parts)).toBe(JSON.stringify(b.parts));
  });
});

describe("validateIntent", () => {
  const rejects = (patch: Record<string, unknown>, match: RegExp) =>
    expect(() => validateIntent({ ...base, ...patch })).toThrowError(match);

  it("rejects an unknown metric", () => {
    rejects({ metric: "ltv" }, /malformed QueryIntent/);
  });

  it("rejects an unknown dimension", () => {
    rejects({ dimensions: ["lead_quality"] }, /malformed QueryIntent/);
  });

  it("refuses to reach into the leakage quarantine", () => {
    rejects({ filters: [{ field: "analysis_only.tags", op: "eq", values: ["x"] }] }, /malformed/);
  });

  it("rejects a backwards date range", () => {
    rejects({ dateRange: { from: "2026-06-30", to: "2026-06-01" } }, /runs backwards/);
  });

  it("rejects a non-date date", () => {
    rejects({ dateRange: { from: "last tuesday", to: "2026-06-01" } }, /YYYY-MM-DD/);
  });

  it("rejects numeric operators on a string field", () => {
    rejects({ filters: [{ field: "lead_source", op: "gt", values: ["G"] }] }, /does not apply/);
  });

  it("rejects a filter with no value", () => {
    rejects({ filters: [{ field: "lead_source", op: "eq", values: [] }] }, /needs at least one value/);
  });

  it("rejects splitting spend by a lead dimension", () => {
    rejects({ metric: "cpl", dimensions: ["owner_id"] }, /cannot be split by owner_id/);
  });

  it("rejects splitting a lead metric by the spend channel", () => {
    rejects({ dimensions: ["channel"] }, /spend dimension/);
  });

  it("rejects filtering a spend metric on a lead field", () => {
    rejects(
      { metric: "cac", filters: [{ field: "occupation", op: "eq", values: ["Student"] }] },
      /cannot filter on occupation/,
    );
  });

  it("rejects a duplicated dimension", () => {
    rejects({ dimensions: ["stage", "stage"] }, /listed twice/);
  });

  it("rejects more than two dimensions", () => {
    rejects({ dimensions: ["stage", "city", "country"] }, /malformed QueryIntent/);
  });

  it("throws IntentError, which is what the repair loop catches", () => {
    expect(() => validateIntent({ ...base, dimensions: ["channel"] })).toThrow(IntentError);
  });

  it("accepts a well-formed intent unchanged", () => {
    const ok = validateIntent(base);
    expect(ok).toEqual(base);
  });
});
