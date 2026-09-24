/**
 * The finding lifecycle. Pure, no database.
 *
 * Re-raising the same alert on every scan is the second way a detector gets
 * muted - the first being false positives - so this behaviour is as
 * load-bearing as the statistics.
 */
import { describe, expect, it } from "vitest";
import { describe as describeFinding, findingKey, mergeFindings, type Finding } from "../findings";

const finding = (over: Partial<Finding> = {}): Finding => {
  const base = {
    detector: "volume" as const,
    kind: "incident" as const,
    direction: "drop" as const,
    dimension: "lead_source",
    member: "Olark Chat",
    window: { from: "2026-06-08", to: "2026-06-28" },
    baseline: { from: "2026-03-01", to: "2026-06-07" },
    observed: 50,
    expected: 100,
    effect: 0.5,
    marketFactor: 1,
    p: 1e-6,
    impactUnits: 50,
    unit: "leads" as const,
    support: { windowUnits: 50, windowEvents: 5, baselineUnits: 400, baselineEvents: 96 },
    ...over,
  };
  return {
    key: findingKey(base.detector, base.dimension, base.member),
    ...base,
    ...describeFinding(base),
  };
};

describe("describe", () => {
  it("states the shortfall in units a person can act on", () => {
    const f = finding();
    expect(f.headline).toBe("Olark Chat: lead volume 50% below expected");
    expect(f.impact).toContain("50 leads fewer than expected");
    expect(f.impact).toContain("while the rest of the pipeline held steady");
  });

  it("says when the expectation was adjusted for a market move", () => {
    const f = finding({ marketFactor: 1.4 });
    expect(f.impact).toContain("rest of the pipeline moving 40%");
  });

  it("never claims a control arm the global cell does not have", () => {
    const f = finding({ kind: "market_shift", dimension: null, member: null });
    expect(f.headline).toContain("whole pipeline");
    expect(f.impact).not.toContain("rest of the pipeline held steady");
    expect(f.impact).toContain("no segment to compare it against");
  });

  it("singularises", () => {
    expect(finding({ impactUnits: 1 }).impact).toContain("1 lead fewer");
  });
});

describe("mergeFindings", () => {
  const t1 = "2026-06-29T07:00:00.000Z";
  const t2 = "2026-06-30T07:00:00.000Z";
  const t3 = "2026-07-01T07:00:00.000Z";

  it("raises a first sighting as new", () => {
    const { tracked, newlyRaised } = mergeFindings([], [finding()], t1);
    expect(tracked[0]!.status).toBe("new");
    expect(tracked[0]!.scanCount).toBe(1);
    expect(newlyRaised).toHaveLength(1);
  });

  it("does not re-raise the same finding on the next scan", () => {
    const first = mergeFindings([], [finding()], t1).tracked;
    const second = mergeFindings(first, [finding()], t2);
    expect(second.tracked[0]!.status).toBe("ongoing");
    expect(second.tracked[0]!.scanCount).toBe(2);
    expect(second.newlyRaised, "an ongoing finding must not alert again").toHaveLength(0);
  });

  it("keeps the first-seen time as the finding ages", () => {
    const first = mergeFindings([], [finding()], t1).tracked;
    const second = mergeFindings(first, [finding()], t2).tracked;
    expect(second[0]!.firstSeenAt).toBe(t1);
    expect(second[0]!.lastSeenAt).toBe(t2);
  });

  it("keeps the note written when it was first raised", () => {
    const first = mergeFindings([], [{ ...finding(), narrative: "check chat routing" }], t1).tracked;
    const second = mergeFindings(first, [finding()], t2).tracked;
    expect(second[0]!.narrative).toBe("check chat routing");
  });

  it("marks a finding resolved once it stops firing", () => {
    const first = mergeFindings([], [finding()], t1).tracked;
    const second = mergeFindings(first, [], t2);
    expect(second.tracked[0]!.status).toBe("resolved");
    expect(second.newlyRaised).toHaveLength(0);
  });

  it("drops a resolved finding on the following scan", () => {
    const first = mergeFindings([], [finding()], t1).tracked;
    const second = mergeFindings(first, [], t2).tracked;
    expect(mergeFindings(second, [], t3).tracked).toHaveLength(0);
  });

  it("raises again if the same problem comes back after resolving", () => {
    const first = mergeFindings([], [finding()], t1).tracked;
    const resolved = mergeFindings(first, [], t2).tracked;
    const again = mergeFindings(resolved, [finding()], t3);
    expect(again.tracked[0]!.status).toBe("new");
    expect(again.newlyRaised).toHaveLength(1);
    expect(again.tracked[0]!.firstSeenAt).toBe(t3);
  });

  it("carries an acknowledgement forward so it does not reappear at the top", () => {
    const first = mergeFindings([], [finding()], t1).tracked;
    first[0]!.acknowledgedAt = t1;
    const second = mergeFindings(first, [finding()], t2).tracked;
    expect(second[0]!.acknowledgedAt).toBe(t1);
  });

  it("ranks incidents above market shifts of the same size", () => {
    const inc = finding();
    const mkt = finding({ kind: "market_shift", dimension: null, member: null });
    const { tracked } = mergeFindings([], [mkt, inc], t1);
    expect(tracked[0]!.kind).toBe("incident");
  });

  it("ranks by impact, and sinks what has been acknowledged", () => {
    const big = finding({ member: "Google", impactUnits: 200 });
    const small = finding({ member: "Reference", impactUnits: 20 });
    const first = mergeFindings([], [big, small], t1).tracked;
    expect(first[0]!.member).toBe("Google");

    first.find((f) => f.member === "Google")!.acknowledgedAt = t1;
    const second = mergeFindings(first, [big, small], t2).tracked;
    expect(second[0]!.member).toBe("Reference");
  });

  it("keeps the board bounded", () => {
    const many = Array.from({ length: 80 }, (_, i) => finding({ member: `Source ${i}`, impactUnits: i }));
    expect(mergeFindings([], many, t1, 10).tracked).toHaveLength(10);
  });
});
