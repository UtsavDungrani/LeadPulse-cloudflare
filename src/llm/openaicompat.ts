/**
 * An `AiRunner` backed by any OpenAI-compatible chat-completions endpoint.
 *
 * Why this exists: the Workers AI binding is the only way this app could reach a
 * model, and a Workers AI account has a hard daily allocation. When it runs out
 * the agent stops answering entirely - the planner throws, and there is no
 * degraded mode to fall back to, because the fallbacks in `analyst.ts` cover a
 * model that answered badly, not a model that could not be reached at all.
 *
 * `llm/workersai.ts` only ever calls `run(model, input)` on the binding, so a
 * single adapter at that seam lets a self-hosted Ollama, vLLM or llama.cpp
 * server - or another provider's OpenAI-compatible API - drive the whole agent
 * without the rest of the LLM layer knowing the difference.
 *
 * Two shape differences have to be reconciled, and both are the kind of thing
 * that fails silently rather than loudly:
 *
 *   - Workers AI takes `response_format.json_schema` as the schema itself.
 *     OpenAI nests it as `response_format.json_schema.schema` alongside a name.
 *     Send the Workers AI shape to an OpenAI-compatible server and the schema is
 *     quietly ignored, which means unconstrained output and a planner that
 *     starts failing to parse for no visible reason.
 *   - Workers AI replies with `{ response }`, OpenAI with
 *     `{ choices: [{ message: { content } }] }`.
 *
 * Note on structured output: schema enforcement is the server's job. Self-hosted
 * Ollama 0.5+ constrains decoding with a grammar and genuinely honours the
 * schema; Ollama Cloud accepts the field and ignores it. An endpoint that
 * ignores it will look like it works and then produce malformed plans under
 * load, so prefer one that enforces.
 */

/** The seam `llm/workersai.ts` talks to. */
export interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface OpenAiCompatOptions {
  /** Base URL, with or without a trailing `/v1`. */
  baseUrl: string;
  /** The model id as that server names it, e.g. `qwen2.5:32b`. */
  model: string;
  /** Bearer token. Omitted for a local Ollama, which wants none. */
  apiKey?: string;
  /** Per-request ceiling. Generous because a large local model is slow. */
  timeoutMs?: number;
  /**
   * Stream the reply and reassemble it. Default true, and it matters more than
   * it looks: a Cloudflare quick tunnel aborts a request with HTTP 524 after
   * about 100 seconds without a response, and a 32B model answering a
   * 3,000-token prompt takes longer than that. The limit is on time to first
   * byte, not total duration, so streaming turns a request that fails outright
   * into one that simply takes a while.
   *
   * What streaming cannot rescue is a model that is not loaded yet: there is no
   * first token to send while Ollama reads 20 GB into VRAM, so the 524 comes
   * back regardless. That one is fixed at the server - `OLLAMA_KEEP_ALIVE=-1`
   * plus a warm-up call - not here. See gateway/README.md.
   */
  stream?: boolean;
}

/**
 * Normalises a base URL to the chat-completions path.
 *
 * Ollama, vLLM and llama.cpp all serve the OpenAI surface under `/v1`, and
 * leaving it off produces a 404 that reads like a tunnel fault rather than a
 * path mistake - so it is appended when absent.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

/**
 * Reassembles an OpenAI-style SSE stream into the full text plus usage.
 *
 * Tolerant by design: servers differ on whether they send a final `[DONE]`, on
 * whether usage arrives in its own chunk, and on how chunks straddle reads. A
 * strict parser here would trade one timeout failure for a parsing one.
 */
async function readSse(
  res: Response,
): Promise<{ text: string; usage?: Record<string, number> }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "" };
  const decoder = new TextDecoder();
  let buffered = "";
  let text = "";
  let usage: Record<string, number> | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });

    // Events are newline-delimited; the tail may be a partial line, so it stays
    // in the buffer until the next read completes it.
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
          usage?: Record<string, number>;
        };
        const piece =
          chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "";
        if (piece) text += piece;
        if (chunk.usage) usage = chunk.usage;
      } catch {
        // A chunk that will not parse is a chunk, not the response. Skipping it
        // loses a token at worst; throwing would lose the whole answer.
      }
    }
  }
  return { text, usage };
}

export function createOpenAiCompatRunner(opts: OpenAiCompatOptions): AiRunner {
  const url = chatCompletionsUrl(opts.baseUrl);
  const timeoutMs = opts.timeoutMs ?? 300_000;

  return {
    async run(_model: string, input: Record<string, unknown>): Promise<unknown> {
      const rf = input.response_format as
        | { type?: string; json_schema?: unknown }
        | undefined;

      const stream = opts.stream !== false;
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: input.messages ?? [],
        temperature: input.temperature ?? 0,
        max_tokens: input.max_tokens ?? 2048,
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      };
      if (rf?.type === "json_schema" && rf.json_schema) {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "schema", schema: rf.json_schema, strict: false },
        };
      } else if (rf?.type === "json_object") {
        body.response_format = { type: "json_object" };
      }

      // Workers' fetch has no default timeout, and a dead tunnel otherwise hangs
      // the request until the platform kills the whole invocation.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
      } catch (err) {
        throw new Error(
          `the model endpoint at ${url} could not be reached: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 300);
        // A tunnel that is down answers with an HTML error document. Saying so
        // beats pasting markup into a log the reader has to decode.
        const looksLikeHtml = /^\s*(<!doctype html|<html)/i.test(text);
        throw new Error(
          looksLikeHtml
            ? `the model endpoint at ${url} returned an HTML error page (HTTP ${res.status}) - ` +
              "the server or tunnel in front of it is down or overloaded"
            : `the model endpoint at ${url} returned HTTP ${res.status}: ${text}`,
        );
      }

      if (stream) {
        const { text, usage } = await readSse(res);
        return { response: text, usage };
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: Record<string, number>;
      };
      // Reshaped into what the Workers AI runner expects, including `usage`, so
      // token accounting and tracing keep working unchanged.
      return { response: data.choices?.[0]?.message?.content ?? "", usage: data.usage };
    },
  };
}
