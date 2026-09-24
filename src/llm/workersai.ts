/**
 * Workers AI provider - the documented fallback.
 *
 * Zero config and no API key, which makes it the right thing to reach for when
 * a demo has to run on a fresh checkout. It is weaker at strict JSON adherence,
 * so the union that Claude expresses as two tools is flattened into one object
 * with an `action` discriminator, and the repair loop is more forgiving.
 *
 * Switch with `LLM_PROVIDER` in `wrangler.jsonc`. If intent accuracy in the
 * eval suite drops when you flip it, that is the expected result, not a bug -
 * it is the cost of not holding a key.
 */
import type { AgentPlan } from "../semantic/intent";
import { validateIntent, IntentError } from "../semantic/intent";
import type { ResultSet } from "../semantic/execute";
import type { ChartType } from "../semantic/chart";
import { intentSystemPrompt, narrationSystemPrompt, narrationUserPrompt, type PromptContext } from "./prompts";
import { DECLINE_SCHEMA, NARRATION_SCHEMA, NarrationSchema, RUN_QUERY_SCHEMA, type Narration } from "./schema";
import { LLMError, type LLMProvider } from "./types";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_REPAIRS = 2;

/** The two tools, flattened - smaller models handle a discriminator better than a union. */
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["run_query", "decline"] },
    intent: RUN_QUERY_SCHEMA,
    decline: DECLINE_SCHEMA,
  },
  required: ["action"],
  additionalProperties: false,
};

interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

async function askJson(
  ai: AiRunner,
  system: string,
  user: string,
  schema: Record<string, unknown>,
): Promise<unknown> {
  const raw = (await ai.run(MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: schema },
    max_tokens: 2048,
  })) as { response?: unknown };

  const payload = raw?.response ?? raw;
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      throw new LLMError("model returned text that is not JSON", "workers-ai");
    }
  }
  return payload;
}

export function createWorkersAiProvider(ai: unknown): LLMProvider {
  const runner = ai as AiRunner;
  if (typeof runner?.run !== "function") {
    throw new LLMError("the AI binding is missing", "workers-ai");
  }

  return {
    name: "workers-ai",

    async plan(question, ctx: PromptContext): Promise<AgentPlan> {
      const system = `${intentSystemPrompt(ctx)}

Reply with a single JSON object. Set "action" to "run_query" and fill "intent", or set
it to "decline" and fill "decline" with { reason, suggestion }. No prose, no markdown.`;
      let user = question;
      let lastError = "";

      for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
        const out = (await askJson(runner, system, user, PLAN_SCHEMA)) as {
          action?: string;
          intent?: unknown;
          decline?: { reason?: string; suggestion?: string };
        };

        if (out?.action === "decline") {
          return {
            kind: "refusal",
            reason: out.decline?.reason ?? "This question cannot be answered from the lead data.",
            suggestion: out.decline?.suggestion ?? "",
          };
        }
        try {
          return { kind: "query", intent: validateIntent(out?.intent) };
        } catch (e) {
          if (!(e instanceof IntentError)) throw e;
          lastError = e.message;
          user = `${question}\n\nYour previous answer was rejected: ${lastError}\nReturn a corrected JSON object.`;
        }
      }

      throw new LLMError(`could not produce a valid QueryIntent: ${lastError}`, "workers-ai");
    },

    async narrate(question, result: ResultSet, allowedChartTypes: ChartType[]): Promise<Narration> {
      const out = await askJson(
        runner,
        narrationSystemPrompt(allowedChartTypes),
        narrationUserPrompt(question, result),
        NARRATION_SCHEMA,
      );
      const parsed = NarrationSchema.safeParse(out);
      if (!parsed.success) throw new LLMError("narration did not match the expected schema", "workers-ai");
      return parsed.data;
    },
  };
}
