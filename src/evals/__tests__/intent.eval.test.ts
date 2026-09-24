/**
 * Intent-accuracy and refusal-correctness eval.
 *
 * Two halves, deliberately separated:
 *
 *  - The **structural** checks run always and cost nothing. They prove the
 *    golden set itself is valid and that every case compiles. A golden file
 *    that has quietly drifted out of sync with the registries is worse than no
 *    golden file, because it fails loudly against a correct agent.
 *  - The **model** checks call the planner once per case and are therefore
 *    opt-in and billable:
 *
 *      RUN_EVALS=1 ANTHROPIC_API_KEY=sk-... npm run eval:intents
 *
 * Grading is on the *compiled pipeline*, not on the intent object. Two intents
 * that differ cosmetically but compile to the same query are both correct.
 */
import { describe, expect, it } from "vitest";
import { compileQuery } from "../../semantic/compile";
import { validateIntent, type QueryIntent } from "../../semantic/intent";
import { createProvider } from "../../llm";
import { EVAL_TODAY, GOLDEN } from "../golden";

const DATA_WINDOW = { from: "2025-07-24", to: "2026-09-24" };

/** Canonical form of what a question will actually ask the database. */
function fingerprint(intent: QueryIntent): string {
  const compiled = compileQuery(intent, intent.dateRange);
  return JSON.stringify({
    parts: compiled.parts,
    grain: compiled.grain,
    compareTo: intent.compareTo,
    limit: intent.limit,
  });
}

describe("the golden set is internally valid", () => {
  it("has unique ids", () => {
    const ids = GOLDEN.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers refusals as well as queries", () => {
    const refusals = GOLDEN.filter((c) => c.expect.kind === "refusal").length;
    expect(refusals).toBeGreaterThanOrEqual(5);
    expect(GOLDEN.length - refusals).toBeGreaterThanOrEqual(15);
  });

  for (const c of GOLDEN.filter((g) => g.expect.kind === "query")) {
    it(`${c.id}: expected intent validates and compiles`, () => {
      const intent = (c.expect as { intent: QueryIntent }).intent;
      expect(validateIntent(intent)).toEqual(intent);
      expect(() => fingerprint(intent)).not.toThrow();
    });
  }

  for (const c of GOLDEN.filter((g) => g.previous)) {
    it(`${c.id}: the preceding intent validates`, () => {
      expect(() => validateIntent(c.previous)).not.toThrow();
    });
  }

  it("keeps every expected date inside the data window", () => {
    for (const c of GOLDEN) {
      if (c.expect.kind !== "query") continue;
      const { from, to } = c.expect.intent.dateRange;
      expect(from >= DATA_WINDOW.from, `${c.id} from`).toBe(true);
      expect(to <= DATA_WINDOW.to, `${c.id} to`).toBe(true);
    }
  });
});

const runModel = Boolean(process.env.RUN_EVALS && process.env.ANTHROPIC_API_KEY);

describe.skipIf(!runModel)("the planner produces the expected intents", () => {
  // Built lazily: `describe` bodies run even when the suite is skipped, and
  // constructing the provider without a key throws.
  let llm: ReturnType<typeof createProvider> | null = null;
  const planner = () =>
    (llm ??= createProvider({
      LLM_PROVIDER: "claude",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    }));

  for (const c of GOLDEN) {
    it(c.id, async () => {
      const plan = await planner().plan(c.question, {
        today: EVAL_TODAY,
        dataWindow: DATA_WINDOW,
        previousIntent: c.previous ?? null,
      });

      if (c.expect.kind === "refusal") {
        expect(plan.kind, `${c.id} should have been declined`).toBe("refusal");
        return;
      }

      expect(plan.kind, `${c.id} should have produced a query`).toBe("query");
      if (plan.kind !== "query") return;
      expect(fingerprint(plan.intent)).toBe(fingerprint(c.expect.intent));
    }, 60_000);
  }
});
