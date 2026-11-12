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
import {
  checkFigures,
  createOpenAiCompatRunner,
  createProvider,
  narrationUserPrompt,
  overviewBrief,
  refusalMessage,
} from "../llm";
import type { AgentPlan } from "../semantic/intent";
import type { Env } from "../agents/analyst";
import { EVAL_TODAY, GOLDEN } from "./golden";
import { EVAL_DATA_WINDOW, gradePlan, fingerprint, type Verdict } from "./grade";
import { createDriverDataSource } from "../db/driver";
import { readOnly } from "../db/readonly";
import { execute, toNarrationTable, allowedFigures } from "../semantic/execute";
import { suggestChart, compatibleCharts } from "../semantic/chart";
import { overviewSummary, runOverview } from "../semantic/overview";
import { fallbackHeadline, fallbackNarrative } from "../agents/analyst";
import {
  activeTraceId,
  flushTelemetry,
  initTelemetry,
  telemetryDestinations,
  traceAgentTurn,
  withRemoteTrace,
} from "../telemetry";

export type EvalEnv = Env & { EVALS_ENABLED?: string };

/**
 * The judge model for the Ragas metrics, and the embedding model behind answer
 * relevancy. Both are Workers AI, reached through the OpenAI-compatible routes
 * below, so the eval needs no third-party key to run.
 *
 * The judge has to support JSON-schema-constrained output; swapping in a model
 * that does not will put every structured metric back into the failure mode this
 * suite was built to expose.
 */
const EVAL_JUDGE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/**
 * Bumped whenever the shape of `retrievedContexts` or `reference` changes.
 *
 * The runner records agent runs on disk and replays them to re-score without
 * re-running the agent. That is only sound while the recorded contexts match
 * what the current code would produce - change the chunking and a replayed run
 * silently scores the old shape, which looks like the metric moved when really
 * the input did. The runner keys its cache on this, so a bump just misses.
 */
const EVAL_CONTEXT_SCHEMA = 4;

/** What the agent itself plans and narrates with, when it runs on Workers AI. */
const EVAL_AGENT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// bge-m3 at 1,075 neurons/M input against bge-base's 6,058, for a longer
// context window and no loss on short analytics questions.
const EVAL_EMBEDDING_MODEL = "@cf/baai/bge-m3";

/**
 * Wraps the AI binding so the agent's own token spend is visible to the runner.
 *
 * The planner and the narrator are two Workers AI calls per case, made inside
 * the Worker where the Python runner cannot see them. Its neuron budget was
 * therefore counting only the judge - wrong in the one direction that matters,
 * since it would approve a run that the agent half had already pushed over the
 * daily allocation.
 *
 * `AiRunner` in `llm/workersai.ts` is just `run(model, input)`, so a counting
 * wrapper is enough and no production code has to know about it.
 */
function meteredAI(ai: Env["AI"], labelAs?: string) {
  const byModel: Record<
    string,
    { promptTokens: number; completionTokens: number; calls: number }
  > = {};

  const run = async (model: string, input: Record<string, unknown>): Promise<unknown> => {
    const res = (await (
      ai as unknown as { run: (m: string, i: unknown) => Promise<unknown> }
    ).run(model, input)) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    // `model` here is the id baked into llm/workersai.ts, which is the wrong
    // label when the call was actually forwarded elsewhere: the runner would
    // then charge another provider's tokens against the neuron budget and could
    // stop a run that had spent nothing.
    const key = labelAs ?? model;
    const slot = (byModel[key] ??= { promptTokens: 0, completionTokens: 0, calls: 0 });
    slot.calls += 1;
    // Workers AI does not always return usage. Estimating from the prompt at
    // four characters per token keeps the total honest-ish, rather than letting
    // a missing field read as a free call.
    slot.promptTokens +=
      res?.usage?.prompt_tokens ??
      Math.ceil(JSON.stringify(input.messages ?? input).length / 4);
    slot.completionTokens += res?.usage?.completion_tokens ?? 0;
    return res;
  };

  return { binding: { run } as unknown as Env["AI"], report: () => byModel };
}

/**
 * The narrator's brief, split into chunks, for use as `retrieved_contexts`.
 *
 * Deliberately the same facts as `narrationUserPrompt` in `llm/prompts.ts`:
 * the judge has to be shown what the writer was shown. If the two drift
 * apart the eval measures the gap between them instead of measuring the
 * model. One fact per chunk rather than one blob also gives context
 * precision something to discriminate on.
 */
function narrationContexts(
  result: import("../semantic/execute").ResultSet,
  tableRows: Record<string, unknown>[],
): string[] {
  const t = result.total;
  const chunks = [
    `Metric: ${result.metric.label} (${result.metric.id}, ${result.metric.unit}); ` +
      `${result.metric.higherIsBetter ? "higher is better" : "lower is better"} for the business.`,
    `Window: ${result.range.from} to ${result.range.to}, grain ${result.grain}.`,
    // The two "nothing was requested" facts are merged into one chunk. They have
    // to be here - knowing there is no comparison window is what stops the
    // narrator inventing one, so faithfulness needs them - but as separate
    // chunks they are two of seven, and context precision scores each chunk on
    // whether it helps answer the question. Boilerplate never does, so splitting
    // them out was costing precision for nothing and buying an extra judge call
    // per chunk.
    [
      result.dimensions.length > 0
        ? `Split by: ${result.dimensions.join(", ")}.`
        : "No breakdown was requested.",
      result.comparisonRange
        ? `Comparison window: ${result.comparisonRange.from} to ${result.comparisonRange.to}.`
        : "No comparison window was requested.",
    ].join(" "),
    `Whole-window total: ${t ? t.formatted : "n/a"}${
      t?.comparison ? ` (prior window ${t.comparison.formatted})` : ``
    }.`,
  ];
  if (result.meta.notes.length > 0) {
    chunks.push(`Caveats to respect: ${result.meta.notes.join(" ")}`);
  }
  chunks.push(
    `Data table (${result.meta.rowCount} rows):\n${JSON.stringify(tableRows, null, 2)}`,
  );
  return chunks;
}

/**
 * A deterministic, English rendering of a result set.
 *
 * This is the `reference` the reference-based Ragas metrics grade against. It is
 * built by executing the *golden* intent - the one the case asserts is correct -
 * not the planner's intent, so it is ground truth the planner cannot influence.
 * Grading a planner's answer against the planner's own query would be circular
 * and would score a confidently wrong answer as correct.
 */
function referenceAnswer(result: import("../semantic/execute").ResultSet): string {
  const parts: string[] = [];
  const total = result.total;
  if (total) {
    parts.push(
      `${result.metric.label} for ${result.range.from} to ${result.range.to} is ${total.formatted}.`,
    );
    if (total.comparison && total.comparison.formatted !== "n/a") {
      parts.push(`The comparison window is ${total.comparison.formatted}.`);
    }
  }
  if (result.dimensions.length > 0 || result.grain !== "total") {
    for (const r of result.rows.slice(0, 25)) {
      const label = [
        r.period ?? null,
        ...result.dimensions.map((d) => r.dims[d]).filter(Boolean),
      ]
        .filter(Boolean)
        .join(" / ");
      if (label) parts.push(`${label}: ${r.formatted}.`);
    }
  }
  if (parts.length === 0) parts.push("No rows matched this query.");
  return parts.join(" ");
}

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
      // What the agent will actually plan and narrate with. The runner keys its
      // recorded runs on this: replaying a run made by one model while
      // configured for another would attribute one model's answers to the other.
      agentModel: env.LLM_BASE_URL ? (env.LLM_MODEL ?? "unknown") : EVAL_AGENT_MODEL,
      contextSchema: EVAL_CONTEXT_SCHEMA,
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

  // OpenAI-compatible chat-completion proxy for local evaluators (Ragas), backed
  // by the Worker's Workers AI binding.
  //
  // Ragas 0.4 metrics are structured-output metrics: every judge call asks for a
  // specific JSON shape and parses the reply into a Pydantic model. A proxy that
  // drops `response_format` therefore fails every metric, which is exactly how
  // this suite came to report invented scores. So the two things that matter here
  // are that `response_format` reaches the model and that `usage` comes back.
  //
  // The shapes differ: OpenAI nests the schema as
  // `response_format.json_schema.schema`, Workers AI takes it flat as
  // `response_format.json_schema`. Unwrapping that is the whole translation.
  if (
    (url.pathname === "/api/eval/chat" ||
      url.pathname === "/api/eval/chat/completions" ||
      url.pathname === "/api/eval/v1/chat/completions") &&
    req.method === "POST"
  ) {
    const body = (await req.json().catch(() => ({}))) as {
      messages?: { role: "system" | "user" | "assistant"; content: string }[];
      temperature?: number;
      max_tokens?: number;
      max_completion_tokens?: number;
      model?: string;
      response_format?: {
        type?: "text" | "json_object" | "json_schema";
        json_schema?: { name?: string; schema?: unknown; strict?: boolean } | unknown;
      };
    };

    try {
      const model =
        body.model && body.model.startsWith("@cf/")
          ? (body.model as any)
          : EVAL_JUDGE_MODEL;

      const rf = body.response_format;
      let responseFormat: { type: "json_object" | "json_schema"; json_schema?: unknown } | undefined;
      if (rf?.type === "json_schema") {
        // Accept either the OpenAI envelope or a bare schema.
        const envelope = rf.json_schema as { schema?: unknown } | undefined;
        const schema =
          envelope && typeof envelope === "object" && "schema" in envelope
            ? envelope.schema
            : rf.json_schema;
        responseFormat = schema
          ? { type: "json_schema", json_schema: schema }
          : { type: "json_object" };
      } else if (rf?.type === "json_object") {
        responseFormat = { type: "json_object" };
      }

      const res = (await env.AI.run(model, {
        messages: body.messages ?? [],
        temperature: body.temperature ?? 0,
        max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 2048,
        ...(responseFormat ? { response_format: responseFormat } : {}),
      } as any)) as { response?: unknown; usage?: Record<string, number> };

      // In JSON mode Workers AI hands back a parsed object, but an OpenAI client
      // expects `message.content` to be a string it can parse itself.
      const content =
        typeof res.response === "string" ? res.response : JSON.stringify(res.response ?? "");

      return Response.json({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: String(model),
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: res.usage?.prompt_tokens ?? 0,
          completion_tokens: res.usage?.completion_tokens ?? 0,
          total_tokens: res.usage?.total_tokens ?? 0,
        },
      });
    } catch (err) {
      return Response.json(
        { error: { message: err instanceof Error ? err.message : String(err), type: "worker_ai_error" } },
        { status: 500 },
      );
    }
  }

  // OpenAI-compatible embeddings, for the one Ragas metric that needs vectors:
  // answer relevancy works by having the judge reverse-engineer questions from
  // the answer and then measuring cosine similarity against the real one. With
  // no embedding endpoint that metric cannot run at all.
  if (
    (url.pathname === "/api/eval/embeddings" || url.pathname === "/api/eval/v1/embeddings") &&
    req.method === "POST"
  ) {
    const body = (await req.json().catch(() => ({}))) as {
      input?: string | string[];
      model?: string;
    };
    const inputs = Array.isArray(body.input) ? body.input : body.input ? [body.input] : [];
    if (inputs.length === 0) {
      return Response.json(
        { error: { message: "`input` is required", type: "invalid_request_error" } },
        { status: 400 },
      );
    }

    try {
      const model =
        body.model && body.model.startsWith("@cf/") ? (body.model as any) : EVAL_EMBEDDING_MODEL;

      // Workers AI caps the batch; chunk rather than silently truncating, because
      // a short embedding list would misalign relevancy scores against samples.
      const vectors: number[][] = [];
      for (let k = 0; k < inputs.length; k += 96) {
        const chunk = inputs.slice(k, k + 96);
        const out = (await env.AI.run(model, { text: chunk } as any)) as { data?: number[][] };
        if (!out?.data || out.data.length !== chunk.length) {
          throw new Error(
            `embedding model returned ${out?.data?.length ?? 0} vectors for ${chunk.length} inputs`,
          );
        }
        vectors.push(...out.data);
      }

      return Response.json({
        object: "list",
        model: String(model),
        data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      return Response.json(
        { error: { message: err instanceof Error ? err.message : String(err), type: "worker_ai_error" } },
        { status: 500 },
      );
    }
  }

  // End-to-end evaluation: runs the plan, executes against MongoDB, generates narration,
  // and formats the retrieved contexts and generated response for Ragas evaluation.
  if (url.pathname === "/api/eval/end-to-end" && req.method === "POST") {
    const {
      id,
      agentBaseUrl,
      agentModel,
      agentApiKey,
    } = (await req.json().catch(() => ({}))) as {
      id?: string;
      agentBaseUrl?: string;
      agentModel?: string;
      agentApiKey?: string;
    };
    const c = GOLDEN.find((g) => g.id === id);
    if (!c) {
      return Response.json({ ok: false, error: `no golden case with id "${id}"` }, { status: 404 });
    }

    initTelemetry(env);
    // Metered only here: the eval runner needs the agent's token spend, the
    // agents themselves do not.
    // Off by default. Supplying agentBaseUrl swaps the model under the agent,
    // which is a different measurement - see llm/openaicompat.ts.

    // Precedence: an override on the request, then whatever the Worker is
    // configured with, then the Workers AI binding. The second case is the
    // important one - when the app itself is pointed at an external model, the
    // eval must exercise *that*, or it would be grading a pipeline nobody runs.
    const effectiveAgentModel = agentBaseUrl
      ? (agentModel ?? "qwen2.5:32b")
      : env.LLM_BASE_URL
        ? (env.LLM_MODEL ?? "unknown")
        : EVAL_AGENT_MODEL;
    const onWorkersAI = !agentBaseUrl && !env.LLM_BASE_URL;
    const meter = meteredAI(
      agentBaseUrl
        ? (createOpenAiCompatRunner({
            baseUrl: agentBaseUrl,
            model: effectiveAgentModel,
            apiKey: agentApiKey,
          }) as unknown as Env["AI"])
        : env.LLM_BASE_URL
          ? (createOpenAiCompatRunner({
              baseUrl: env.LLM_BASE_URL,
              model: effectiveAgentModel,
              apiKey: env.LLM_API_KEY,
            }) as unknown as Env["AI"])
          : env.AI,
      effectiveAgentModel,
    );
    // AI is already the chosen runner, so clear LLM_BASE_URL or createProvider
    // would build a second one and the meter would see nothing.
    const llm = createProvider({ ...env, LLM_BASE_URL: undefined, AI: meter.binding });
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

    if (!plan) {
      return Response.json({
        ok: false,
        id: c.id,
        question: c.question,
        error: error ?? "Planner failed",
      });
    }

    if (plan.kind === "refusal") {
      const message = refusalMessage(plan.reason, plan.suggestion);
      const verdict = gradePlan(c.expect, plan);
      return Response.json({
        ok: true,
        id: c.id,
        question: c.question,
        isRefusal: true,
        verdict,
        response: message,
        reason: plan.reason,
        suggestion: plan.suggestion,
        context: "The requested metric or dimension is outside the semantic catalogue.",
        // For a refusal there is no numeric answer to match, so ground truth is
        // the act of declining. The runner grades these with a rubric instead of
        // with faithfulness, which has nothing to be faithful to here.
        reference:
          "This question cannot be answered from the available data. The correct response declines to answer, says why, and offers a question the data can answer instead.",
        retrievedContexts: [
          "Allowed metrics: leads_created, deals_won, deal_conversion_pct, revenue_won, open_pipeline, pipeline_volume, cycle_time_days, time_to_first_contact_min, total_spend, cac, roas.",
          "Allowed dimensions: lead_source, rep_id, channel, campaign, region, status, stage.",
        ],
        aiUsage: meter.report(),
        contextSchema: EVAL_CONTEXT_SCHEMA,
        agentModel: effectiveAgentModel,
        agentOnWorkersAI: onWorkersAI,
        latencyMs: Date.now() - startedAt,
      });
    }

    if (plan.kind === "query") {
      const ds = readOnly(createDriverDataSource(env.MONGODB_URI, env.MONGODB_DB_NAME));
      const result = await execute(ds, plan.intent);

      // Ground truth for the reference-based metrics: the *golden* intent run
      // against the same data. `result` above is whatever the planner chose to
      // ask, so the two diverge exactly when the planner got it wrong - which is
      // the signal context-precision and context-recall are there to pick up.
      let reference: string | null = null;
      let referenceContexts: string[] | null = null;
      if (c.expect.kind === "query") {
        try {
          const truth = await execute(ds, c.expect.intent);
          reference = referenceAnswer(truth);
          referenceContexts = [
            `Query Metric: ${truth.metric.id} (${truth.metric.unit})`,
            `Query Grain: ${truth.grain}`,
            `Date Range: ${truth.range.from} to ${truth.range.to}`,
            `Data Table:
${JSON.stringify(toNarrationTable(truth, 25), null, 2)}`,
          ];
        } catch {
          // Leaving these null is honest: the runner skips the reference-based
          // metrics for this case rather than grading against a guess.
          reference = null;
          referenceContexts = null;
        }
      }
      const chart = suggestChart(result);
      const points = result.rows.map((r) => ({
        period: r.period,
        dims: r.dims,
        value: r.value,
        formatted: r.formatted,
        comparison: r.comparison?.value ?? null,
      }));
      const allowedCharts = compatibleCharts(chart, points);

      let headline = fallbackHeadline(result);
      let narrative = fallbackNarrative(result);
      let figuresChecked = false;
      let inventedFigures: string[] = [];

      try {
        const narration = await llm.narrate(c.question, result, allowedCharts);
        const figures = checkFigures(
          `${narration.headline} ${narration.narrative}`,
          narrationUserPrompt(c.question, result),
        );
        figuresChecked = figures.ok;
        if (figures.ok) {
          headline = narration.headline;
          narrative = narration.narrative;
        } else {
          inventedFigures = figures.invented;
        }
      } catch {
        // Fallback stands
      }

      // The same row budget the narrator gets. `narrationUserPrompt` builds its
      // table with `toNarrationTable(result)` - 60 rows by default - so capping
      // the judge's copy at 25 meant every figure the narrator read from rows
      // 26-60 looked invented. On a 127-row question like "monthly lead volume
      // by source for the last year" that is most of the answer, and it shows up
      // as a faithfulness failure on exactly the breakdowns that matter most.
      // Whatever the narrator saw is what the judge has to see.
      const tableRows = toNarrationTable(result);
      const allowed = allowedFigures(result);
      const verdict = gradePlan(c.expect, plan);

      return Response.json({
        ok: true,
        id: c.id,
        question: c.question,
        isRefusal: false,
        verdict,
        headline,
        narrative,
        response: `${headline}. ${narrative}`,
        contextTable: JSON.stringify(tableRows),
        // Faithfulness only means something when the context the judge sees is
        // the context the narrator had. `narrationUserPrompt` hands the narrator
        // the metric's polarity, the whole-window total, the comparison window
        // and the caveats. Chunking from the rows alone drops all of that, so
        // the judge marks "which is good, since higher is better" as an
        // unsupported claim - when the narration prompt is what asked for that
        // sentence. Those are false hallucination findings, and they land
        // hardest on the cases that behaved correctly.
        retrievedContexts: narrationContexts(result, tableRows),
        tableRows,
        reference,
        referenceContexts,
        allowedFigures: allowed,
        figuresChecked,
        inventedFigures,
        aiUsage: meter.report(),
        contextSchema: EVAL_CONTEXT_SCHEMA,
        agentModel: effectiveAgentModel,
        agentOnWorkersAI: onWorkersAI,
        latencyMs: Date.now() - startedAt,
      });
    }

    // "Give me a report for last week" plans as an overview, not a query. This
    // branch was missing, so every overview case came back HTTP 400 and was
    // dropped from the suite - a case that silently never runs is a case that
    // cannot fail, which is its own kind of fake pass.
    if (plan.kind === "overview") {
      const ds = readOnly(createDriverDataSource(env.MONGODB_URI, env.MONGODB_DB_NAME));
      const result = await runOverview(ds, plan.overview, EVAL_DATA_WINDOW.to);
      const brief = overviewBrief(c.question, result);
      const computed = overviewSummary(result);

      let { headline, narrative } = computed;
      let figuresChecked = false;
      let inventedFigures: string[] = [];

      try {
        const written = await llm.narrateOverview(c.question, brief);
        const figures = checkFigures(`${written.headline} ${written.narrative}`, brief);
        figuresChecked = figures.ok;
        if (figures.ok) {
          headline = written.headline || headline;
          narrative = written.narrative;
        } else {
          inventedFigures = figures.invented;
        }
      } catch {
        // The computed summary stands, exactly as in the agent.
      }

      // The brief is what the narrator actually saw, so it is the retrieved
      // context - one chunk per tile, so context precision can discriminate
      // between the tiles that bear on the question and the ones that do not.
      const retrievedContexts = [
        `Window: ${result.period.from} to ${result.period.to}, against ${result.priorPeriod.from} to ${result.priorPeriod.to}`,
        ...[...result.live, ...result.matured].map(
          (t) =>
            `${t.label} (${t.id}): ${t.formatted}, prior window ${t.priorFormatted}` +
            `${t.changePct === null ? "" : `, ${t.changePct >= 0 ? "+" : ""}${t.changePct.toFixed(0)}%`}; ` +
            `${t.higherIsBetter ? "higher is better" : "lower is better"}`,
        ),
      ];

      let reference: string | null = null;
      if (c.expect.kind === "query") {
        try {
          reference = referenceAnswer(await execute(ds, c.expect.intent));
        } catch {
          reference = null;
        }
      }

      return Response.json({
        ok: true,
        id: c.id,
        question: c.question,
        isRefusal: false,
        verdict: gradePlan(c.expect, plan),
        headline,
        narrative,
        response: `${headline}. ${narrative}`,
        retrievedContexts,
        reference,
        referenceContexts: null,
        figuresChecked,
        inventedFigures,
        aiUsage: meter.report(),
        contextSchema: EVAL_CONTEXT_SCHEMA,
        agentModel: effectiveAgentModel,
        agentOnWorkersAI: onWorkersAI,
        latencyMs: Date.now() - startedAt,
      });
    }

    return Response.json({ ok: false, error: "Unsupported plan kind" }, { status: 400 });
  }

  return Response.json({ ok: false, error: `unknown eval route ${url.pathname}` }, { status: 404 });
}
