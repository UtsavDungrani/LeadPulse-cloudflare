import { createWorkersAiProvider } from "./workersai";
import type { LLMProvider } from "./types";

export type { LLMProvider } from "./types";
export { LLMError } from "./types";
export type { PromptContext } from "./prompts";
export { refusalMessage } from "./prompts";
export type { Narration, OverviewNarration } from "./schema";
export { checkFigures, usableProse } from "./figures";
export { narrationUserPrompt, overviewBrief } from "./prompts";
export { createWorkersAiProvider } from "./workersai";

/**
 * Creates the Workers AI LLM provider.
 */
export function createProvider(env: {
  LLM_PROVIDER?: string;
  AI?: unknown;
}): LLMProvider {
  if (env.AI) return createWorkersAiProvider(env.AI);
  throw new Error("Cloudflare Workers AI binding (env.AI) is required");
}

