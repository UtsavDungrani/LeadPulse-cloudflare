import { describe, expect, it } from "vitest";
import {
  benjaminiHochberg,
  binomialCdf,
  binomialTwoSidedP,
  logGamma,
  poissonCdf,
  poissonTwoSidedP,
} from "../stats";

describe("logGamma", () => {
  it("reproduces factorials", () => {
    expect(Math.exp(logGamma(5))).toBeCloseTo(24, 6); // 4!
    expect(Math.exp(logGamma(11))).toBeCloseTo(3_628_800, 2); // 10!
  });

  it("knows gamma(1/2) = sqrt(pi)", () => {
    expect(Math.exp(logGamma(0.5))).toBeCloseTo(Math.sqrt(Math.PI), 10);
  });

  it("stays finite where a naive factorial would overflow", () => {
    expect(Number.isFinite(logGamma(2000))).toBe(true);
  });
});

describe("poissonCdf", () => {
  it("matches hand-computed values", () => {
    // P(X<=0 | 1) = e^-1
    expect(poissonCdf(0, 1)).toBeCloseTo(Math.exp(-1), 12);
    // P(X<=2 | 2) = e^-2 (1 + 2 + 2)
    expect(poissonCdf(2, 2)).toBeCloseTo(Math.exp(-2) * 5, 12);
  });

  it("approaches 1 far above the mean", () => {
    expect(poissonCdf(200, 50)).toBeCloseTo(1, 10);
  });

  it("is exact at large lambda, where a normal approximation drifts", () => {
    // P(X <= 100 | 100) is just over a half because of the discrete mass at 100.
    expect(poissonCdf(100, 100)).toBeGreaterThan(0.5);
    expect(poissonCdf(100, 100)).toBeLessThan(0.54);
  });
});

describe("poissonTwoSidedP", () => {
  it("is 1 when the observation is the mean", () => {
    expect(poissonTwoSidedP(10, 10)).toBeGreaterThan(0.9);
  });

  it("is tiny for a large shortfall", () => {
    expect(poissonTwoSidedP(50, 138)).toBeLessThan(1e-10);
  });

  it("is symmetric in direction, not in magnitude", () => {
    expect(poissonTwoSidedP(5, 20)).toBeLessThan(0.01);
    expect(poissonTwoSidedP(40, 20)).toBeLessThan(0.01);
  });

  it("never exceeds 1, despite doubling a tail", () => {
    for (const k of [0, 1, 5, 9, 10, 11, 20]) {
      expect(poissonTwoSidedP(k, 10)).toBeLessThanOrEqual(1);
    }
  });

  it("treats a zero expectation as certainty", () => {
    expect(poissonTwoSidedP(0, 0)).toBe(1);
    expect(poissonTwoSidedP(3, 0)).toBe(0);
  });
});

describe("binomialCdf", () => {
  it("matches a hand-computed coin flip", () => {
    // P(X<=1 | n=3, p=0.5) = (1 + 3)/8
    expect(binomialCdf(1, 3, 0.5)).toBeCloseTo(0.5, 12);
  });

  it("is 1 at n and 0 below zero", () => {
    expect(binomialCdf(10, 10, 0.3)).toBe(1);
    expect(binomialCdf(-1, 10, 0.3)).toBe(0);
  });
});

describe("binomialTwoSidedP", () => {
  it("is near 1 at the expected count", () => {
    expect(binomialTwoSidedP(36, 100, 0.36)).toBeGreaterThan(0.9);
  });

  it("detects the planted Olark-scale collapse", () => {
    // 6 conversions from 91 leads against a 24% baseline.
    expect(binomialTwoSidedP(6, 91, 0.2403)).toBeLessThan(1e-4);
  });

  it("does not fire on a small sample with a large apparent swing", () => {
    // 4 of 10 against 25% looks like a 60% lift and means nothing.
    expect(binomialTwoSidedP(4, 10, 0.25)).toBeGreaterThan(0.2);
  });

  it("handles degenerate rates without dividing by zero", () => {
    expect(binomialTwoSidedP(0, 50, 0)).toBeLessThanOrEqual(1);
    expect(binomialTwoSidedP(50, 50, 1)).toBeLessThanOrEqual(1);
  });
});

describe("benjaminiHochberg", () => {
  const ps = (xs: number[]) => xs.map((p) => ({ p }));

  it("rejects nothing when every p-value is large", () => {
    const r = benjaminiHochberg(ps([0.2, 0.4, 0.9]), (x) => x.p, 0.05);
    expect(r.passed).toHaveLength(0);
    expect(r.threshold).toBeNull();
  });

  it("rejects the smallest when it clears i/m * q", () => {
    const r = benjaminiHochberg(ps([0.001, 0.4, 0.9]), (x) => x.p, 0.05);
    expect(r.passed.map((x) => x.p)).toEqual([0.001]);
  });

  it("steps up: a later passing rank carries the earlier ones with it", () => {
    // 0.03 <= 3/4 * 0.05 fails, but 0.04 <= 4/4 * 0.05 passes, so all four go.
    const r = benjaminiHochberg(ps([0.01, 0.02, 0.03, 0.04]), (x) => x.p, 0.05);
    expect(r.passed).toHaveLength(4);
    expect(r.threshold).toBe(0.04);
  });

  it("is stricter than an uncorrected cutoff on a wide sweep", () => {
    // 100 tests, one genuine signal and 99 uniform nulls: an uncorrected
    // p < 0.05 would admit about five of the nulls.
    const nulls = Array.from({ length: 99 }, (_, i) => ({ p: (i + 1) / 100 }));
    const r = benjaminiHochberg([{ p: 1e-6 }, ...nulls], (x) => x.p, 0.05);
    expect(r.passed).toHaveLength(1);
  });

  it("copes with an empty sweep", () => {
    expect(benjaminiHochberg([], (x: { p: number }) => x.p, 0.05).tested).toBe(0);
  });
});
