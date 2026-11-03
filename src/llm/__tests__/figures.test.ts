/**
 * The check that makes model-written prose safe to show.
 *
 * A model asked to describe numbers will occasionally produce one that was
 * never in the data, and that is the single failure a reader cannot catch -
 * it looks exactly like every true sentence around it. Every figure in the
 * prose has to have come from the brief, or the prose is thrown away.
 */
import { describe, expect, it } from "vitest";
import { checkFigures, usableProse } from "../figures";

const BRIEF = `The question was: how did last week go
Window: 2026-09-14 to 2026-09-20, against 2026-09-07 to 2026-09-13.

Measured about the window itself:
- Leads created: 181 (prior window 169, +7%; higher is better)
- Cost per lead: ₹364 (prior window ₹409, -11%; lower is better)
- SLA breach rate: 40.3% (prior window 45.2%, -11%; lower is better)`;

describe("checkFigures", () => {
  it("passes prose that only uses figures from the brief", () => {
    const prose = "Leads created rose 7% to 181, while cost per lead fell 11% to ₹364.";
    expect(checkFigures(prose, BRIEF)).toEqual({ ok: true, invented: [] });
  });

  it("catches a figure that was never in the data", () => {
    // 212 is plausible, sits in a true sentence, and is not in the brief.
    const prose = "Leads created rose to 212 last week, the best of the quarter.";
    const check = checkFigures(prose, BRIEF);
    expect(check.ok).toBe(false);
    expect(check.invented).toContain("212");
  });

  it("catches a recomputed figure as readily as an invented one", () => {
    // 12 is the arithmetic on 181 against 169 done slightly wrong. The brief
    // says +7%, so this is exactly the number the model was told not to derive.
    expect(checkFigures("Leads were up 12% on the week.", BRIEF).ok).toBe(false);
  });

  it("does not punish a dropped trailing zero", () => {
    expect(checkFigures("SLA breaches ran at 40.3%, down from 45.2%.", BRIEF).ok).toBe(true);
    expect(checkFigures("SLA breaches ran at 40.30%.", BRIEF).ok).toBe(true);
  });

  it("does not punish a dropped thousands separator", () => {
    expect(checkFigures("1240 leads.", "Leads created: 1,240").ok).toBe(true);
    expect(checkFigures("1,240 leads.", "Leads created: 1240").ok).toBe(true);
  });

  it("ignores the unit, because the digits are what can be invented", () => {
    // The brief said ₹364; saying "364 rupees" is the same figure.
    expect(checkFigures("Cost per lead was 364 rupees.", BRIEF).ok).toBe(true);
  });

  it("allows prose with no figures at all", () => {
    expect(checkFigures("Volume held steady and nothing needs attention.", BRIEF).ok).toBe(true);
  });

  it("reads dates as figures too, so a window cannot be invented", () => {
    expect(checkFigures("Over the week to 2026-09-20, volume rose.", BRIEF).ok).toBe(true);
    expect(checkFigures("Over the week to 2026-08-30, volume rose.", BRIEF).ok).toBe(false);
  });
});

describe("usableProse", () => {
  it("rejects an empty gesture", () => {
    expect(usableProse("")).toBe(false);
    expect(usableProse("Things look fine.")).toBe(false);
  });

  it("rejects prose with no number in it", () => {
    const wordy = "Everything about the pipeline this week looks broadly consistent with the previous one.";
    expect(wordy.length).toBeGreaterThan(60);
    expect(usableProse(wordy)).toBe(false);
  });

  it("accepts a real read-out", () => {
    expect(
      usableProse("Leads created rose 7% to 181 while cost per lead fell 11% to ₹364, both in your favour."),
    ).toBe(true);
  });
});
