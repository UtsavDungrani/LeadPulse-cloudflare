import { createClaudeProvider } from "./claude";
import { createWorkersAiProvider } from "./workersai";
import type { LLMProvider } from "./types";

export type { LLMProvider } from "./types";
export { LLMError } from "./types";
export type { PromptContext } from "./prompts";
export { refusalMessage } from "./prompts";
export type { Narration } from "./schema";

/**
 * Pick a provider from config.
 *
 * Claude is the default because strict structured output is the whole job of
 * the planning call. Workers AI stays wired so a checkout with no key still
 * runs - it falls back automatically rather than failing at boot.
 */
export function createProvider(env: {
  LLM_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  AI?: unknown;
}): LLMProvider {
  const wants = env.LLM_PROVIDER ?? "claude";
  if (wants === "claude" && env.ANTHROPIC_API_KEY) {
    return createClaudeProvider(env.ANTHROPIC_API_KEY);
  }
  if (wants === "claude" && !env.ANTHROPIC_API_KEY && env.AI) {
    return createWorkersAiProvider(env.AI);
  }
  if (env.AI) return createWorkersAiProvider(env.AI);
  return createClaudeProvider(env.ANTHROPIC_API_KEY ?? "");
}
