/**
 * How a planner answer is graded, in one place.
 *
 * This was duplicated inside `__tests__/intent.eval.test.ts`; it now lives here
 * because the HTTP eval route (`route.ts`) has to grade identically, and two
 * copies of a grading rule is how a suite starts disagreeing with itself.
 */
import { compileQuery } from "../semantic/compile";
import type { AgentPlan, QueryIntent } from "../semantic/intent";
import type { GoldenCase } from "./golden";

/** The span the data actually covers. Every expected date sits inside it. */
export const EVAL_DATA_WINDOW = { from: "2025-07-24", to: "2026-09-24" };

/**
 * Canonical form of what a question will actually ask the database.
 *
 * Grading on the compiled pipeline rather than on the intent object is the
 * whole trick: two intents that differ cosmetically but compile to the same
 * query are both correct, and grading the object would fail one of them for no
 * reason.
 */
export function fingerprint(intent: QueryIntent): string {
  const compiled = compileQuery(intent, intent.dateRange);
  return JSON.stringify({
    parts: compiled.parts,
    grain: compiled.grain,
    compareTo: intent.compareTo,
    limit: intent.limit,
  });
}

export interface Verdict {
  pass: boolean;
  expectedKind: "query" | "refusal";
  actualKind: AgentPlan["kind"] | "error";
  expectedFingerprint: string | null;
  actualFingerprint: string | null;
  /** Plain English, because this string ends up on the Langfuse score. */
  reason: string;
}

/**
 * Grades one plan against one golden case.
 *
 * The two failure directions are not symmetric and are reported separately: a
 * wrong pipeline is a bad answer, while answering a question that should have
 * been declined is the failure that actually costs someone money.
 */
export function gradePlan(expect: GoldenCase["expect"], plan: AgentPlan): Verdict {
  if (expect.kind === "refusal") {
    const pass = plan.kind === "refusal";
    return {
      pass,
      expectedKind: "refusal",
      actualKind: plan.kind,
      expectedFingerprint: null,
      actualFingerprint: plan.kind === "query" ? fingerprint(plan.intent) : null,
      reason: pass
        ? "declined, as it should have"
        : `answered with a ${plan.kind} a question it has no data for`,
    };
  }

  const expectedFingerprint = fingerprint(expect.intent);

  if (plan.kind !== "query") {
    return {
      pass: false,
      expectedKind: "query",
      actualKind: plan.kind,
      expectedFingerprint,
      actualFingerprint: null,
      reason:
        plan.kind === "refusal"
          ? "declined a question the data can answer"
          : "returned an overview where a specific query was asked for",
    };
  }

  const actualFingerprint = fingerprint(plan.intent);
  const pass = actualFingerprint === expectedFingerprint;
  return {
    pass,
    expectedKind: "query",
    actualKind: "query",
    expectedFingerprint,
    actualFingerprint,
    reason: pass ? "compiles to the expected pipeline" : "compiles to a different pipeline",
  };
}
