/**
 * Claude provider - the default.
 *
 * Structured output is the entire job of the first call, and Claude is
 * materially better at strict schema adherence than the Workers AI fallback,
 * which is why `LLM_PROVIDER` defaults to `claude`. See `workersai.ts` for the
 * no-key path.
 *
 * `tool_choice` is left on `auto` rather than forced. Forcing a tool interacts
 * badly with thinking on some models, and an explicit instruction naming the
 * two tools plus `strict: true` gets the same behaviour without the coupling.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AgentPlan } from "../semantic/intent";
import { validateIntent, IntentError } from "../semantic/intent";
import type { ResultSet } from "../semantic/execute";
import type { ChartType } from "../semantic/chart";
import { intentSystemPrompt, narrationSystemPrompt, narrationUserPrompt, type PromptContext } from "./prompts";
import { DECLINE_SCHEMA, DeclineSchema, NarrationSchema, RUN_QUERY_SCHEMA, type Narration } from "./schema";
import { LLMError, type LLMProvider } from "./types";

const MODEL = "claude-opus-5";

/** One repair round. A second one has never fixed what the first could not. */
const MAX_REPAIRS = 1;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "run_query",
    description:
      "Answer the question by running a query. Emit the QueryIntent; a deterministic compiler turns it into an aggregation.",
    strict: true,
    input_schema: RUN_QUERY_SCHEMA as Anthropic.Tool.InputSchema,
  },
  {
    name: "decline",
    description:
      "The question cannot be answered from this data. Explain what is missing and suggest the nearest answerable question.",
    strict: true,
    input_schema: DECLINE_SCHEMA as Anthropic.Tool.InputSchema,
  },
];

export function createClaudeProvider(apiKey: string): LLMProvider {
  if (!apiKey) throw new LLMError("ANTHROPIC_API_KEY is not set", "claude");
  const client = new Anthropic({ apiKey });

  return {
    name: "claude",

    async plan(question, ctx: PromptContext): Promise<AgentPlan> {
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
      let lastError = "";

      for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 4096,
          system: intentSystemPrompt(ctx),
          tools: TOOLS,
          tool_choice: { type: "auto" },
          messages,
        });

        if (response.stop_reason === "refusal") {
          throw new LLMError("the planner declined to answer for safety reasons", "claude");
        }

        const call = response.content.find(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );
        if (!call) {
          lastError = "You must answer by calling either run_query or decline.";
        } else if (call.name === "decline") {
          const parsed = DeclineSchema.safeParse(call.input);
          if (parsed.success) {
            return { kind: "refusal", reason: parsed.data.reason, suggestion: parsed.data.suggestion };
          }
          lastError = "The decline call was malformed; it needs `reason` and `suggestion`.";
        } else {
          try {
            return { kind: "query", intent: validateIntent(call.input) };
          } catch (e) {
            if (!(e instanceof IntentError)) throw e;
            lastError = e.message;
          }
        }

        // Feed the failure back verbatim. The model repairs its own object far
        // more reliably than it re-derives one from a paraphrased complaint.
        messages.push(
          { role: "assistant", content: response.content },
          {
            role: "user",
            content: call
              ? [
                  {
                    type: "tool_result",
                    tool_use_id: call.id,
                    is_error: true,
                    content: `Rejected: ${lastError} Call the tool again with a corrected object.`,
                  },
                ]
              : lastError,
          },
        );
      }

      throw new LLMError(`could not produce a valid QueryIntent: ${lastError}`, "claude");
    },

    async narrate(question, result: ResultSet, allowedChartTypes: ChartType[]): Promise<Narration> {
      const response = await client.messages.parse({
        model: MODEL,
        max_tokens: 2048,
        system: narrationSystemPrompt(allowedChartTypes),
        messages: [{ role: "user", content: narrationUserPrompt(question, result) }],
        output_config: { format: zodOutputFormat(NarrationSchema) },
      });

      const parsed = response.parsed_output;
      if (!parsed) throw new LLMError("narration did not match the expected schema", "claude");
      return parsed;
    },
  };
}
