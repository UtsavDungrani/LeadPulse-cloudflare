/**
 * A second destination for the same spans: LangSmith, alongside Langfuse.
 *
 * The naive version of this - point an OTLP exporter at LangSmith and be done -
 * produces traces that arrive but say nothing. Langfuse's SDK writes its own
 * attribute namespace (`langfuse.observation.model.name`, `.usage_details`,
 * `.input`, ...), and LangSmith reads none of it. You get correctly shaped,
 * correctly nested, entirely empty spans: no model, no prompt, no tokens.
 *
 * So this file is a translator. It wraps the OTLP exporter, rewrites each
 * span's attributes from Langfuse's vocabulary into the one LangSmith reads,
 * and forwards it. Nothing in the agents changes, and Langfuse is untouched -
 * both processors hang off the same tracer provider and see the same spans.
 *
 * Attribute mapping (Langfuse -> LangSmith):
 *
 *   observation.input          -> input.value          (OpenInference; takes JSON)
 *   observation.output         -> output.value
 *   observation.model.name     -> gen_ai.request.model
 *   observation.usage_details  -> gen_ai.usage.{input,output,total}_tokens
 *   observation.type           -> langsmith.span.kind  (generation->llm, tool->tool, span->chain)
 *   observation.metadata       -> langsmith.metadata.{key}
 *   trace.name                 -> langsmith.trace.name
 *   trace.tags                 -> langsmith.span.tags  (comma-separated)
 *   trace.input / trace.output -> input.value / output.value when the span has none
 *
 * `input.value`/`output.value` are used rather than `gen_ai.input.messages`
 * because Langfuse stores these as JSON strings and the OpenInference pair is
 * documented to accept a string or JSON. The gen_ai message attributes expect
 * structured arrays, which would mean re-parsing and reshaping payloads that
 * are already correct.
 */
import type { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { ExportResult } from "@opentelemetry/core";
import type { Attributes } from "@opentelemetry/api";

/** Langfuse observation type -> LangSmith run type. */
const SPAN_KIND: Record<string, string> = {
  generation: "llm",
  tool: "tool",
  span: "chain",
  event: "chain",
  agent: "chain",
  embedding: "embedding",
  retriever: "retriever",
};

/** Parses a Langfuse attribute that may arrive as a JSON string or a value. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Rewrites one span's attributes into LangSmith's vocabulary.
 *
 * Langfuse's own attributes are deliberately left in place: they cost nothing
 * in LangSmith, and stripping them would make the two backends disagree about
 * what was recorded.
 */
export function toLangSmithAttributes(src: Attributes): Attributes {
  const out: Attributes = { ...src };
  const get = (k: string) => src[k];

  const type = asString(get("langfuse.observation.type"));
  if (type) out["langsmith.span.kind"] = SPAN_KIND[type] ?? "chain";

  const model = asString(get("langfuse.observation.model.name"));
  if (model) {
    out["gen_ai.request.model"] = model;
    out["gen_ai.response.model"] = model;
    // Tells LangSmith to treat the span as an LLM call even if type is absent.
    if (!out["langsmith.span.kind"]) out["langsmith.span.kind"] = "llm";
    out["gen_ai.operation.name"] ??= "chat";
  }

  const input = get("langfuse.observation.input") ?? get("langfuse.trace.input");
  const inputStr = asString(input);
  if (inputStr !== undefined) out["input.value"] = inputStr;

  const output = get("langfuse.observation.output") ?? get("langfuse.trace.output");
  const outputStr = asString(output);
  if (outputStr !== undefined) out["output.value"] = outputStr;

  const usage = parseMaybeJson(get("langfuse.observation.usage_details"));
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const inTok = num(u.input) ?? num(u.prompt_tokens) ?? num(u.input_tokens);
    const outTok = num(u.output) ?? num(u.completion_tokens) ?? num(u.output_tokens);
    const total = num(u.total) ?? num(u.total_tokens);
    if (inTok !== undefined) out["gen_ai.usage.input_tokens"] = inTok;
    if (outTok !== undefined) out["gen_ai.usage.output_tokens"] = outTok;
    if (total !== undefined) out["gen_ai.usage.total_tokens"] = total;
    else if (inTok !== undefined && outTok !== undefined) {
      out["gen_ai.usage.total_tokens"] = inTok + outTok;
    }
  }

  const traceName = asString(get("langfuse.trace.name"));
  if (traceName) out["langsmith.trace.name"] = traceName;

  // Langfuse carries tags as an array; LangSmith wants one comma-separated string.
  const tags = parseMaybeJson(get("langfuse.trace.tags"));
  if (Array.isArray(tags) && tags.length) out["langsmith.span.tags"] = tags.join(",");

  const sessionId = asString(get("langfuse.trace.session_id")) ?? asString(get("session.id"));
  if (sessionId) out["langsmith.trace.session_id"] = sessionId;

  for (const key of ["langfuse.observation.metadata", "langfuse.trace.metadata"]) {
    const meta = parseMaybeJson(get(key));
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      out[`langsmith.metadata.${k}`] = typeof v === "object" ? JSON.stringify(v) : (v as never);
    }
  }

  // Langfuse flattens metadata onto the span too; carry those across as well.
  for (const [k, v] of Object.entries(src)) {
    if (!k.startsWith("langfuse.observation.metadata.")) continue;
    const short = k.slice("langfuse.observation.metadata.".length);
    if (v !== undefined && v !== null) out[`langsmith.metadata.${short}`] = v;
  }

  return out;
}

/** A ReadableSpan with its attributes swapped, prototype and methods intact. */
function retag(span: ReadableSpan): ReadableSpan {
  return Object.create(span, {
    attributes: { value: toLangSmithAttributes(span.attributes), enumerable: true },
  }) as ReadableSpan;
}

/** Wraps an exporter so everything it sends speaks LangSmith's vocabulary. */
export class LangSmithTranslatingExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    let translated: ReadableSpan[];
    try {
      translated = spans.map(retag);
    } catch (err) {
      console.warn("[leadpulse/langsmith] attribute translation failed:", err);
      translated = spans;
    }
    this.inner.export(translated, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export interface LangSmithConfig {
  LANGSMITH_API_KEY?: string;
  LANGSMITH_PROJECT?: string;
  /** Base URL without /v1/traces - the exporter appends it. Defaults to US. */
  LANGSMITH_ENDPOINT?: string;
}

export interface LangSmithProcessor {
  processor: SimpleSpanProcessor;
  exporter: SpanExporter;
  endpoint: string;
  project: string;
}

/**
 * Builds the LangSmith span processor, or null when no key is configured.
 *
 * `SimpleSpanProcessor` rather than a batching one, to match how Langfuse is
 * set up here (`exportMode: "immediate"`): a Worker isolate can be torn down
 * between requests, and a batch queue that never flushes is worse than a few
 * extra requests.
 */
export function createLangSmithProcessor(config: LangSmithConfig): LangSmithProcessor | null {
  const apiKey =
    config.LANGSMITH_API_KEY ??
    (typeof process !== "undefined" ? process.env.LANGSMITH_API_KEY : undefined);
  if (!apiKey) return null;

  const base = (
    config.LANGSMITH_ENDPOINT ??
    (typeof process !== "undefined" ? process.env.LANGSMITH_ENDPOINT : undefined) ??
    "https://api.smith.langchain.com/otel"
  ).replace(/\/+$/, "");
  const project =
    config.LANGSMITH_PROJECT ??
    (typeof process !== "undefined" ? process.env.LANGSMITH_PROJECT : undefined) ??
    "leadpulse";

  const exporter = new LangSmithTranslatingExporter(
    new OTLPTraceExporter({
      url: `${base}/v1/traces`,
      headers: { "x-api-key": apiKey, "Langsmith-Project": project },
    }),
  );

  return {
    processor: new SimpleSpanProcessor(exporter),
    exporter,
    endpoint: `${base}/v1/traces`,
    project,
  };
}
