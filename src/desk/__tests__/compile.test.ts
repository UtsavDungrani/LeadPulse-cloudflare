import { describe, expect, it } from "vitest";
import { compileAction, compileCount, compileUndoCapture } from "../compile";
import { validateAction, ActionError, MAX_AFFECTED, type ActionIntent } from "../actions";

const base = {
  action: "reassign_owner" as const,
  filters: [{ field: "lead_source" as const, op: "eq" as const, values: ["Olark Chat"] }],
  dateRange: { from: "2026-06-01", to: "2026-06-30" },
  value: "REP007",
  reason: "Olark leads need the chat-trained rep",
  limit: 50,
};

const intent = (patch: Record<string, unknown> = {}): ActionIntent =>
  validateAction({ ...base, ...patch });

describe("compileAction", () => {
  it("emits the exact filter and update", () => {
    const c = compileAction(intent());
    expect(c.collection).toBe("leads");
    expect(c.filter).toEqual({
      created_at: {
        $gte: new Date("2026-06-01T00:00:00.000Z"),
        $lt: new Date("2026-07-01T00:00:00.000Z"),
      },
      $and: [{ lead_source: "Olark Chat" }],
    });
    expect(c.update).toEqual({ $set: { owner_id: "REP007" } });
  });

  it("only ever emits $set", () => {
    for (const action of ["reassign_owner", "set_stage", "set_do_not_email", "set_do_not_call"]) {
      const value =
        action === "reassign_owner" ? "REP007" : action === "set_stage" ? "Attempting" : "true";
      const c = compileAction(intent({ action, value }));
      expect(Object.keys(c.update)).toEqual(["$set"]);
    }
  });

  it("coerces a boolean action to a real boolean", () => {
    const c = compileAction(intent({ action: "set_do_not_email", value: "true" }));
    expect(c.update.$set).toEqual({ "consent.do_not_email": true });
  });

  it("keeps stage and is_open consistent", () => {
    // Writing one without the other makes open_pipeline disagree with stage,
    // and nothing downstream would notice.
    expect(compileAction(intent({ action: "set_stage", value: "Attempting" })).update.$set).toEqual({
      stage: "Attempting",
      is_open: true,
    });
    expect(compileAction(intent({ action: "set_stage", value: "Lost" })).update.$set).toEqual({
      stage: "Lost",
      is_open: false,
    });
  });

  it("excludes converted leads from any stage change, and says so", () => {
    const c = compileAction(intent({ action: "set_stage", value: "Attempting" }));
    expect(c.filter.$and).toContainEqual({ converted: false });
    expect(c.guards.join(" ")).toMatch(/converted leads are excluded/);
  });

  it("does not add that guard to other actions", () => {
    expect(compileAction(intent()).filter.$and).not.toContainEqual({ converted: false });
  });

  it("captures every written field for the undo", () => {
    const c = compileAction(intent({ action: "set_stage", value: "Lost" }));
    const [match, limit, project] = compileUndoCapture(c, 10);
    expect(match).toEqual({ $match: c.filter });
    expect(limit).toEqual({ $limit: 10 });
    expect((project as Record<string, Record<string, number>>).$project).toEqual({
      _id: 1,
      lead_number: 1,
      stage: 1,
      is_open: 1,
    });
  });

  it("counts without a zero limit, which Mongo rejects", () => {
    expect(compileCount(compileAction(intent()))).toEqual([
      { $match: compileAction(intent()).filter },
      { $count: "n" },
    ]);
  });

  it("is pure", () => {
    expect(JSON.stringify(compileAction(intent()))).toBe(JSON.stringify(compileAction(intent())));
  });
});

describe("validateAction", () => {
  const rejects = (patch: Record<string, unknown>, match: RegExp) =>
    expect(() => validateAction({ ...base, ...patch })).toThrowError(match);

  it("refuses a proposal with no filters", () => {
    // With a date range alone this would select every lead in the window.
    rejects({ filters: [] }, /malformed ActionIntent/);
  });

  it("refuses an unknown action", () => {
    rejects({ action: "delete_lead" }, /malformed ActionIntent/);
  });

  it("refuses to write a field outside the whitelist", () => {
    // There is no action that reaches `converted`; the enum is the whitelist.
    rejects({ action: "set_converted" }, /malformed ActionIntent/);
  });

  it("refuses to set a stage of Won", () => {
    rejects(
      { action: "set_stage", value: "Won" },
      /conversion is an observed outcome, not something the desk assigns/,
    );
  });

  it("refuses a stage that does not exist", () => {
    rejects({ action: "set_stage", value: "Nurturing" }, /not an assignable stage/);
  });

  it("refuses an owner that is not a rep id", () => {
    rejects({ value: "Priya" }, /not a rep id/);
  });

  it("refuses a non-boolean for a consent flag", () => {
    rejects({ action: "set_do_not_email", value: "maybe" }, /takes "true" or "false"/);
  });

  it("refuses a backwards date range", () => {
    rejects({ dateRange: { from: "2026-06-30", to: "2026-06-01" } }, /runs backwards/);
  });

  it("refuses a limit above the hard ceiling", () => {
    rejects({ limit: MAX_AFFECTED + 1 }, /malformed ActionIntent/);
  });

  it("refuses a proposal with no reason", () => {
    rejects({ reason: "" }, /malformed ActionIntent/);
  });

  it("refuses a filter on a field outside the read whitelist", () => {
    rejects(
      { filters: [{ field: "analysis_only.lead_quality", op: "eq", values: ["High"] }] },
      /malformed ActionIntent/,
    );
  });

  it("throws ActionError, which the repair loop catches", () => {
    expect(() => validateAction({ ...base, value: "nope" })).toThrow(ActionError);
  });

  it("accepts a well-formed proposal unchanged", () => {
    expect(validateAction(base)).toEqual(base);
  });
});
