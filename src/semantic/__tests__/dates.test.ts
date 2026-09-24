import { describe, expect, it } from "vitest";
import {
  calendarAnchors,
  previousPeriod,
  rangeBounds,
  rangeDays,
  samePeriodLastYear,
} from "../dates";

describe("rangeBounds", () => {
  it("is half-open so the last day is included in full", () => {
    expect(rangeBounds({ from: "2026-06-08", to: "2026-06-28" })).toEqual({
      start: new Date("2026-06-08T00:00:00.000Z"),
      endExclusive: new Date("2026-06-29T00:00:00.000Z"),
    });
  });

  it("handles a single day", () => {
    expect(rangeDays({ from: "2026-06-08", to: "2026-06-08" })).toBe(1);
  });
});

describe("previousPeriod", () => {
  it("matches length rather than calendar, so February does not read as a crash", () => {
    // 31 days of March against 31 days ending the day before, not 28 of February.
    expect(previousPeriod({ from: "2026-03-01", to: "2026-03-31" })).toEqual({
      from: "2026-01-29",
      to: "2026-02-28",
    });
  });

  it("abuts the base range with no gap and no overlap", () => {
    const base = { from: "2026-06-08", to: "2026-06-28" };
    const prev = previousPeriod(base);
    expect(prev.to).toBe("2026-06-07");
    expect(rangeDays(prev)).toBe(rangeDays(base));
  });
});

describe("samePeriodLastYear", () => {
  it("keeps the calendar dates", () => {
    expect(samePeriodLastYear({ from: "2026-06-01", to: "2026-06-30" })).toEqual({
      from: "2025-06-01",
      to: "2025-06-30",
    });
  });

  it("clamps 29 February to 28", () => {
    expect(samePeriodLastYear({ from: "2024-02-29", to: "2024-02-29" })).toEqual({
      from: "2023-02-28",
      to: "2023-02-28",
    });
  });
});

describe("calendarAnchors", () => {
  // 2026-09-24 is a Thursday.
  const a = calendarAnchors(new Date("2026-09-24T11:30:00.000Z"));

  it("starts weeks on Monday", () => {
    expect(a.this_week).toEqual({ from: "2026-09-21", to: "2026-09-24" });
    expect(a.last_week).toEqual({ from: "2026-09-14", to: "2026-09-20" });
  });

  it("ends last_month on the real last day", () => {
    expect(a.last_month).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("gives whole calendar quarters", () => {
    expect(a.last_quarter).toEqual({ from: "2026-04-01", to: "2026-06-30" });
    expect(a.this_quarter).toEqual({ from: "2026-07-01", to: "2026-09-24" });
  });

  it("counts trailing windows inclusively", () => {
    expect(a.last_7_days).toEqual({ from: "2026-09-18", to: "2026-09-24" });
    expect(rangeDays(a.last_30_days!)).toBe(30);
  });

  it("ignores the time of day", () => {
    const midnight = calendarAnchors(new Date("2026-09-24T00:00:00.000Z"));
    expect(midnight.today).toEqual(a.today);
  });
});
