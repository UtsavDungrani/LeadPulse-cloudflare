import { createWorkersAiProvider } from "./workersai";
import { createOpenAiCompatRunner } from "./openaicompat";
import type { LLMProvider } from "./types";

export type { LLMProvider } from "./types";
export { LLMError } from "./types";
export type { PromptContext } from "./prompts";
export { refusalMessage } from "./prompts";
export type { Narration, OverviewNarration } from "./schema";
export { checkFigures, usableProse } from "./figures";
export { narrationUserPrompt, overviewBrief } from "./prompts";
export { createWorkersAiProvider } from "./workersai";
export { createOpenAiCompatRunner, chatCompletionsUrl, type AiRunner } from "./openaicompat";

/**
 * Creates the LLM provider.
 *
 * Workers AI by default. Setting `LLM_BASE_URL` points the agent at any
 * OpenAI-compatible endpoint instead - a self-hosted Ollama or vLLM, or another
 * provider - which is what keeps the app answering when the Workers AI daily
 * allocation is gone. The binding is still required to exist for the rest of the
 * Worker, but it is not called while a base URL is set.
 *
 * Deliberately explicit rather than a fallback-on-error: an agent that silently
 * changes model mid-session would make its own answers incomparable, and a
 * number from one model in a conversation grounded on another is the kind of
 * inconsistency nobody would think to look for.
 */
export function createProvider(env: {
  LLM_PROVIDER?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_API_KEY?: string;
  AI?: unknown;
}): LLMProvider {
  if (env.LLM_BASE_URL) {
    if (!env.LLM_MODEL) {
      throw new Error("LLM_BASE_URL is set but LLM_MODEL is not - the endpoint needs a model id");
    }
    return createWorkersAiProvider(
      createOpenAiCompatRunner({
        baseUrl: env.LLM_BASE_URL,
        model: env.LLM_MODEL,
        apiKey: env.LLM_API_KEY,
      }),
    );
  }
  if (env.AI) return createWorkersAiProvider(env.AI);
  throw new Error(
    "no model configured - set LLM_BASE_URL (+ LLM_MODEL) or provide the Workers AI binding (env.AI)",
  );
}

