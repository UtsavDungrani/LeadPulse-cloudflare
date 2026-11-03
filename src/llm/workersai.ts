/**
 * Workers AI provider.
 *
 * Runs via Cloudflare Workers AI binding (zero external API keys required).
 */
import type { AgentPlan } from "../semantic/intent";
import { validateIntent, validateOverview, IntentError } from "../semantic/intent";
import type { ResultSet } from "../semantic/execute";
import type { ChartType } from "../semantic/chart";
import {
  deskSystemPrompt,
  digestSystemPrompt,
  findingSystemPrompt,
  findingUserPrompt,
  intentSystemPrompt,
  narrationSystemPrompt,
  narrationUserPrompt,
  overviewSystemPrompt,
  type DeskContext,
  type FindingBrief,
  type PromptContext,
} from "./prompts";
import {
  DECLINE_SCHEMA,
  FINDING_NOTE_SCHEMA,
  FindingNoteSchema,
  NARRATION_SCHEMA,
  NarrationSchema,
  OVERVIEW_NARRATION_SCHEMA,
  OverviewNarrationSchema,
  OVERVIEW_SCHEMA,
  PROPOSE_ACTION_SCHEMA,
  RUN_QUERY_SCHEMA,
  type Narration,
  type OverviewNarration,
} from "./schema";
import { LLMError, type LLMProvider } from "./types";
import { validateAction, ActionError, type DeskPlan } from "../desk/actions";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_REPAIRS = 2;

/** The three tools, flattened - smaller models handle a discriminator better than a union. */
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["run_query", "overview", "decline"] },
    intent: RUN_QUERY_SCHEMA,
    overview: OVERVIEW_SCHEMA,
    decline: DECLINE_SCHEMA,
  },
  required: ["action"],
  additionalProperties: false,
};

/** The desk union, flattened the same way the read-side plan is. */
const DESK_PLAN_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["propose_action", "decline"] },
    proposal: PROPOSE_ACTION_SCHEMA,
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
  let raw: { response?: unknown };
  try {
    raw = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: schema },
      max_tokens: 2048,
    })) as { response?: unknown };
  } catch (e) {
    // The free allocation is finite and runs out mid-session, with an error
    // that names the plan to buy rather than the switch this project already
    // has. Say the latter, since it is the one that costs nothing to try.
    const message = e instanceof Error ? e.message : String(e);
    if (/allocation|quota|neurons|4006/i.test(message)) {
      throw new LLMError(
        `${message} — Workers AI allocation limit reached for today. Allocation resets daily.`,
        "workers-ai",
      );
    }
    throw new LLMError(message, "workers-ai");
  }

  const payload = raw?.response ?? raw;
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      const salvaged = firstJsonObject(payload);
      if (salvaged !== null) return salvaged;
      // Carrying a snippet of what came back: "not JSON" on its own cannot
      // distinguish a refusal from a truncation from a fenced block, and those
      // want different fixes.
      throw new LLMError(
        `model returned text that is not JSON (${payload.length} chars, ends: ${payload.slice(-90).replace(/\s+/g, " ")})`,
        "workers-ai",
      );
    }
  }
  return payload;
}

/**
 * Pull the JSON object out of a response that has prose around it.
 *
 * This model answers a `json_schema` request with a fenced block or a sentence
 * of preamble often enough that rejecting those outright loses roughly one
 * written summary in four - and what is lost is well-formed JSON with an
 * apology in front of it. Scanning for the outermost balanced braces, ignoring
 * anything inside a string literal, recovers it without guessing at content.
 */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }

  // Ran off the end inside a string: the model wrote its last sentence and
  // forgot to close the quote. Closing it is the one repair worth doing,
  // because nothing is being guessed at - the content is entirely the model's
  // and JSON.parse still has to accept the result.
  return inString ? closeAndParse(text.slice(start), depth) : null;
}

/**
 * Close an unterminated string and any open braces, then parse.
 *
 * Refuses when the text does not end on sentence punctuation, because that
 * means the response was cut off mid-thought rather than merely unclosed - and
 * half a sentence presented as a finished read-out is worse than no sentence.
 */
function closeAndParse(candidate: string, depth: number): unknown {
  if (!/[.!?%)]\s*\}*\s*$/.test(candidate)) return null;
  const withoutBraces = candidate.replace(/[\s}]*$/, "");
  try {
    return JSON.parse(`${withoutBraces}"${"}".repeat(Math.max(depth, 1))}`);
  } catch {
    return null;
  }
}

/**
 * One retry for the calls that only produce prose.
 *
 * This model drops malformed JSON often enough that a single attempt loses the
 * written summary roughly one time in four - and the fallback, while honest, is
 * not what anyone asked to read. Planning does not use this: a bad intent is
 * repaired by feeding the validation error back, which is better than a blind
 * retry. Here there is nothing to feed back, because the failure is the shape
 * of the response rather than its content.
 */
async function askJsonTwice(
  ai: AiRunner,
  system: string,
  user: string,
  schema: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await askJson(ai, system, user, schema);
  } catch {
    return await askJson(ai, system, user, schema);
  }
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

Reply with a single JSON object. Set "action" to "run_query" and fill "intent"; or to
"overview" and fill "overview" with { dateRange, filters, compareTo }; or to "decline"
and fill "decline" with { reason, suggestion }. No prose, no markdown.`;
      let user = question;
      let lastError = "";

      for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
        const out = (await askJson(runner, system, user, PLAN_SCHEMA)) as {
          action?: string;
          intent?: unknown;
          overview?: unknown;
          decline?: { reason?: string; suggestion?: string };
        };

        if (out?.action === "overview") {
          try {
            return { kind: "overview", overview: validateOverview(out.overview) };
          } catch (e) {
            if (!(e instanceof IntentError)) throw e;
            user = `${question}

Your previous answer was rejected: ${e.message}
Return a corrected JSON object.`;
            continue;
          }
        }

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
      const out = await askJsonTwice(
        runner,
        narrationSystemPrompt(allowedChartTypes),
        narrationUserPrompt(question, result),
        NARRATION_SCHEMA,
      );
      const parsed = NarrationSchema.safeParse(out);
      if (!parsed.success) throw new LLMError("narration did not match the expected schema", "workers-ai");
      return parsed.data;
    },

    async propose(request: string, ctx: DeskContext): Promise<DeskPlan> {
      const system = `${deskSystemPrompt(ctx)}

Reply with a single JSON object. Set "action" to "propose_action" and fill "proposal", or
set it to "decline" and fill "decline" with { reason, suggestion }. No prose, no markdown.`;
      let user = request;
      let lastError = "";

      for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
        const out = (await askJson(runner, system, user, DESK_PLAN_SCHEMA)) as {
          action?: string;
          proposal?: unknown;
          decline?: { reason?: string; suggestion?: string };
        };

        if (out?.action === "decline") {
          return {
            kind: "refusal",
            reason: out.decline?.reason ?? "This change cannot be made safely from this request.",
            suggestion: out.decline?.suggestion ?? "",
          };
        }
        try {
          return { kind: "action", intent: validateAction(out?.proposal) };
        } catch (e) {
          if (!(e instanceof ActionError)) throw e;
          lastError = e.message;
          user = `${request}

Your previous proposal was rejected: ${lastError}
Return a corrected JSON object.`;
        }
      }

      throw new LLMError(`could not produce a valid ActionIntent: ${lastError}`, "workers-ai");
    },

    async narrateOverview(question, brief): Promise<OverviewNarration> {
      const out = await askJsonTwice(runner, overviewSystemPrompt(), brief, OVERVIEW_NARRATION_SCHEMA);
      const parsed = OverviewNarrationSchema.safeParse(out);
      if (!parsed.success) throw new LLMError("the overview read-out was malformed", "workers-ai");
      return parsed.data;
    },

    async narrateFinding(finding: FindingBrief): Promise<string> {
      const out = await askJson(
        runner,
        findingSystemPrompt(),
        findingUserPrompt(finding),
        FINDING_NOTE_SCHEMA,
      );
      const parsed = FindingNoteSchema.safeParse(out);
      if (!parsed.success) throw new LLMError("finding note did not match the expected schema", "workers-ai");
      return parsed.data.note;
    },

    async summariseDigest(brief: string): Promise<string> {
      const out = await askJsonTwice(runner, digestSystemPrompt(), brief, FINDING_NOTE_SCHEMA);
      const parsed = FindingNoteSchema.safeParse(out);
      if (!parsed.success) throw new LLMError("digest summary did not match the expected schema", "workers-ai");
      return parsed.data.note;
    },
  };
}

/**
 * Exported for its unit test only. The salvage rule has enough edge cases -
 * braces inside strings, escaped quotes - that testing it through a live model
 * call would test the model instead of the rule.
 */
export { firstJsonObject as __test_firstJsonObject };
