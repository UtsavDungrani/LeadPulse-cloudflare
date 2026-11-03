/**
 * The guard on model-written prose.
 *
 * Wanting the read-out to be written by a model and wanting the numbers in it
 * to be true are not in tension, but only because of this file. Every figure
 * the model may use is handed to it in the brief; this checks that every figure
 * it wrote came from there.
 *
 * It is a containment check, not a correctness proof - a model can still put a
 * real number against the wrong label. What it makes impossible is the failure
 * that matters most, which is a confident, plausible, entirely invented figure.
 */

/**
 * Numbers as a reader would write them: `1,240`, `43.6%`, `₹2.1L`, `9.1 days`,
 * `-29%`. The unit is stripped here because the model is allowed to say "43.6"
 * where the brief said "43.6%" - it is the digits that must be real.
 */
function figures(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(normalise);
}

function normalise(raw: string): string {
  const stripped = raw.replace(/,/g, "");
  // `40` and `40.0` are the same figure; a model that drops a trailing zero has
  // not invented anything.
  return stripped.includes(".") ? stripped.replace(/\.?0+$/, "") || "0" : stripped;
}

export interface FigureCheck {
  ok: boolean;
  /** Figures in the prose that were not in the brief. */
  invented: string[];
}

export function checkFigures(prose: string, brief: string): FigureCheck {
  const allowed = new Set(figures(brief));
  const invented = [...new Set(figures(prose))].filter((f) => !allowed.has(f));
  return { ok: invented.length === 0, invented };
}

/**
 * Whether a written summary is worth showing at all.
 *
 * Short enough to be a refusal, or with no number in it, means the model did
 * not do the job - and the computed fallback is better than an empty gesture.
 */
export function usableProse(text: string, minLength = 60): boolean {
  return text.trim().length >= minLength && /\d/.test(text);
}
