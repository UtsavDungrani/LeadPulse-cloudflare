/**
 * The statistics the Watchtower runs on. Pure functions, no I/O, no AI.
 *
 * Exact tails rather than normal approximations. The cells that matter most
 * are the small ones - a niche channel with 40 leads is exactly where a
 * z-approximation starts inventing significance, and exactly where a false
 * alert costs the most trust. At these counts the exact sum costs nothing.
 */

/** Lanczos approximation; accurate to ~15 significant figures for x > 0. */
export function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = c[0]!;
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

const logFactorial = (n: number): number => logGamma(n + 1);

/** Sum of exponentials in log space, without overflowing. */
function sumExp(logTerms: number[]): number {
  if (logTerms.length === 0) return 0;
  const max = Math.max(...logTerms);
  if (!Number.isFinite(max)) return 0;
  let acc = 0;
  for (const t of logTerms) acc += Math.exp(t - max);
  return Math.exp(max) * acc;
}

/** P(X <= k) for X ~ Poisson(lambda). */
export function poissonCdf(k: number, lambda: number): number {
  if (lambda <= 0) return k >= 0 ? 1 : 0;
  if (k < 0) return 0;
  const terms: number[] = [];
  for (let i = 0; i <= Math.floor(k); i++) {
    terms.push(-lambda + i * Math.log(lambda) - logFactorial(i));
  }
  return Math.min(1, sumExp(terms));
}

/**
 * Two-sided Poisson test of `observed` against `expected`.
 *
 * Uses the doubled-nearer-tail convention. It is slightly conservative
 * compared with the minimum-likelihood method, which is the direction you want
 * an alerting system to err in.
 */
export function poissonTwoSidedP(observed: number, expected: number): number {
  if (expected <= 0) return observed > 0 ? 0 : 1;
  const tail =
    observed >= expected
      ? 1 - poissonCdf(observed - 1, expected)
      : poissonCdf(observed, expected);
  return Math.min(1, Math.max(0, 2 * tail));
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomialCdf(k: number, n: number, p: number): number {
  if (n <= 0) return 1;
  if (p <= 0) return k >= 0 ? 1 : 0;
  if (p >= 1) return k >= n ? 1 : 0;
  if (k < 0) return 0;
  if (k >= n) return 1;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  const terms: number[] = [];
  for (let i = 0; i <= Math.floor(k); i++) {
    terms.push(logFactorial(n) - logFactorial(i) - logFactorial(n - i) + i * lp + (n - i) * lq);
  }
  return Math.min(1, sumExp(terms));
}

/** Two-sided binomial test of `k` successes in `n` trials against rate `p`. */
export function binomialTwoSidedP(k: number, n: number, p: number): number {
  if (n <= 0) return 1;
  const clamped = Math.min(1 - 1e-12, Math.max(1e-12, p));
  const expected = n * clamped;
  const tail =
    k >= expected ? 1 - binomialCdf(k - 1, n, clamped) : binomialCdf(k, n, clamped);
  return Math.min(1, Math.max(0, 2 * tail));
}

export interface FdrResult<T> {
  passed: T[];
  /** Largest p-value that still passed; `null` when nothing did. */
  threshold: number | null;
  tested: number;
}

/**
 * Benjamini-Hochberg false-discovery-rate control.
 *
 * A sweep runs on the order of a hundred tests. At an uncorrected p < 0.05 that
 * is five false alerts every scan, which is precisely how a detector gets
 * switched off. BH keeps the *expected proportion* of false alerts among those
 * raised below `q`, which is the quantity an on-call person actually cares
 * about - unlike Bonferroni, it does not go blind on a wide sweep.
 */
export function benjaminiHochberg<T>(items: T[], pOf: (item: T) => number, q: number): FdrResult<T> {
  const m = items.length;
  if (m === 0) return { passed: [], threshold: null, tested: 0 };

  const sorted = [...items].sort((a, b) => pOf(a) - pOf(b));
  let cutoff = -1;
  for (let i = 0; i < m; i++) {
    if (pOf(sorted[i]!) <= ((i + 1) / m) * q) cutoff = i;
  }
  if (cutoff < 0) return { passed: [], threshold: null, tested: m };
  return {
    passed: sorted.slice(0, cutoff + 1),
    threshold: pOf(sorted[cutoff]!),
    tested: m,
  };
}
