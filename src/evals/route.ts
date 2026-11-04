/**
 * The golden set, exposed over HTTP so it can actually be run.
 *
 * Why this exists: the model half of `__tests__/intent.eval.test.ts` is gated
 * on `globalThis.AI`, and under plain vitest in Node that binding never exists,
 * so that half has always been skipped - intent accuracy has never been
 * measured on this project. The planner needs the Workers AI binding, which
 * only lives inside the Worker. So the planner stays here and the runner moves
 * outside: `scripts/eval_langfuse.mjs` drives these two routes and reports the
 * run to Langfuse as an experiment.
 *
 * Off unless `EVALS_ENABLED` is exactly "true". These routes spend model tokens
 * and, like everything else here, have no authenticated actor in front of them
 * (HANDOFF §11g), so they are set in `.dev.vars` and are not something to leave
 * switched on in a deployment.
 */
import { createProvider } from "../llm";
import type { AgentPlan } from "../semantic/intent";
import type { Env } from "../agents/analyst";
import { EVAL_TODAY, GOLDEN } from "./golden";
import { EVAL_DATA_WINDOW, gradePlan, fingerprint, type Verdict } from "./grade";
import {
  activeTraceId,
  flushTelemetry,
  initTelemetry,
  telemetryDestinations,
  traceAgentTurn,
  withRemoteTrace,
} from "../telemetry";

export type EvalEnv = Env & { EVALS_ENABLED?: string };

export interface EvalCaseResult extends Verdict {
  id: string;
  question: string;
  note?: string;
  latencyMs: number;
  /** The Langfuse trace the planning ran in, for linking from the experiment. */
  traceId: string | null;
  /** Set only when the planner threw rather than answering. */
  error: string | null;
  plan: AgentPlan | null;
}

/**
 * Handles `/api/eval/*`, or returns null so the caller can keep routing.
 */
export async function handleEvalRequest(
  req: Request,
  env: EvalEnv,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/eval")) return null;

  if (env.EVALS_ENABLED !== "true") {
    return Response.json(
      { ok: false, error: 'the eval routes are off - set EVALS_ENABLED="true" in .dev.vars' },
      { status: 404 },
    );
  }

  // The runner reads this first: it is the dataset, and it carries the frozen
  // clock so the grader and the planner agree on what "last week" means.
  if (url.pathname === "/api/eval/cases") {
    return Response.json({
      ok: true,
      today: EVAL_TODAY.toISOString(),
      dataWindow: EVAL_DATA_WINDOW,
      cases: GOLDEN.map((c) => ({
        id: c.id,
        question: c.question,
        note: c.note ?? null,
        previous: c.previous ?? null,
        expected:
          c.expect.kind === "refusal"
            ? { kind: "refusal" as const }
            : { kind: "query" as const, intent: c.expect.intent, fingerprint: fingerprint(c.expect.intent) },
      })),
    });
  }

  // Which tracing backends this Worker is actually exporting to. Useful when a
  // trace does not show up and the question is "is it even configured?".
  if (url.pathname === "/api/eval/telemetry") {
    initTelemetry(env);
    return Response.json({ ok: true, ...telemetryDestinations() });
  }

  if (url.pathname === "/api/eval/run" && req.method === "POST") {
    const { id } = (await req.json().catch(() => ({}))) as { id?: string };
    const c = GOLDEN.find((g) => g.id === id);
    if (!c) {
      return Response.json({ ok: false, error: `no golden case with id "${id}"` }, { status: 404 });
    }

    initTelemetry(env);
    const llm = createProvider(env);

    // Joined to the runner's trace, so the generation lands under the
    // experiment item rather than in a trace of its own.
    const result = await withRemoteTrace(req.headers, () =>
      traceAgentTurn<EvalCaseResult>(
        `eval:${c.id}`,
        {
          input: c.question,
          tags: ["eval", "intent-accuracy", c.expect.kind],
          metadata: {
            caseId: c.id,
            note: c.note,
            today: EVAL_TODAY.toISOString(),
            dataWindow: EVAL_DATA_WINDOW,
            hasPrevious: Boolean(c.previous),
          },
        },
        async () => {
          const startedAt = Date.now();
          let plan: AgentPlan | null = null;
          let error: string | null = null;

          try {
            plan = await llm.plan(c.question, {
              today: EVAL_TODAY,
              dataWindow: EVAL_DATA_WINDOW,
              previousIntent: c.previous ?? null,
            });
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          }

          const latencyMs = Date.now() - startedAt;

          // A throw is a failure of the case, not of the run. Recording it as
          // a scored miss keeps one flaky call from aborting the other 29.
          const verdict: Verdict = plan
            ? gradePlan(c.expect, plan)
            : {
                pass: false,
                expectedKind: c.expect.kind,
                actualKind: "error",
                expectedFingerprint:
                  c.expect.kind === "query" ? fingerprint(c.expect.intent) : null,
                actualFingerprint: null,
                reason: `the planner threw: ${error}`,
              };

          return {
            id: c.id,
            question: c.question,
            note: c.note,
            latencyMs,
            traceId: activeTraceId(),
            error,
            plan,
            ...verdict,
          };
        },
      ),
    );

    // `exportMode: "immediate"` still buffers; without this the Worker can
    // finish the response before the span leaves the isolate.
    await flushTelemetry();

    return Response.json({ ok: true, ...result });
  }

  return Response.json({ ok: false, error: `unknown eval route ${url.pathname}` }, { status: 404 });
}
