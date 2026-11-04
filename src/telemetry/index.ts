import api, { type TracerProvider } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { createLangSmithProcessor, type LangSmithConfig, type LangSmithProcessor } from "./langsmith";
import {
  propagateAttributes,
  setLangfuseTracerProvider,
  startActiveObservation,
  type LangfuseSpan,
  type LangfuseGeneration,
} from "@langfuse/tracing";

let initialized = false;
let spanProcessor: LangfuseSpanProcessor | null = null;
let langsmith: LangSmithProcessor | null = null;
let enabled = false;

export interface TelemetryConfig extends LangSmithConfig {
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  ENVIRONMENT?: string;
}

/**
 * Initialize OpenTelemetry & Langfuse SpanProcessor with provided credentials.
 * Idempotent: safe to call on every request or agent instantiation.
 */
export function initTelemetry(config?: TelemetryConfig): boolean {
  if (initialized && enabled) return true;

  const publicKey =
    config?.LANGFUSE_PUBLIC_KEY ??
    (typeof process !== "undefined" ? process.env.LANGFUSE_PUBLIC_KEY : undefined);
  const secretKey =
    config?.LANGFUSE_SECRET_KEY ??
    (typeof process !== "undefined" ? process.env.LANGFUSE_SECRET_KEY : undefined);
  const baseUrl =
    config?.LANGFUSE_BASE_URL ??
    (typeof process !== "undefined" ? process.env.LANGFUSE_BASE_URL : undefined) ??
    "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) {
    return false;
  }

  try {
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    api.context.setGlobalContextManager(contextManager);

    spanProcessor = new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl,
      exportMode: "immediate",
    });

    // LangSmith, when configured, is a second processor on the SAME provider -
    // not a second provider. Two providers would mean two globals fighting over
    // `api.trace.setGlobalTracerProvider`, and whichever lost would silently
    // stop receiving spans. One provider, two destinations, same spans.
    langsmith = createLangSmithProcessor(config ?? {});

    const provider = new BasicTracerProvider({
      spanProcessors: langsmith ? [spanProcessor, langsmith.processor] : [spanProcessor],
    });

    api.trace.setGlobalTracerProvider(provider as unknown as TracerProvider);
    setLangfuseTracerProvider(provider as unknown as TracerProvider);

    initialized = true;
    enabled = true;
    return true;
  } catch (err) {
    console.warn("[leadpulse/telemetry] Failed to initialize Langfuse tracing:", err);
    return false;
  }
}

export function isTelemetryEnabled(): boolean {
  return enabled;
}

export interface AgentTurnOptions {
  sessionId?: string;
  userId?: string;
  input?: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Trace an entire agent turn (e.g. user question in Analyst, action proposal in LeadDesk).
 * Creates the root SPAN in the trace tree and associates session_id, user_id, input, and output.
 */
export async function traceAgentTurn<T>(
  name: string,
  options: AgentTurnOptions,
  fn: (span: LangfuseSpan | null) => Promise<T>,
): Promise<T> {
  if (!enabled) {
    return fn(null);
  }

  return propagateAttributes(
    {
      sessionId: options.sessionId,
      userId: options.userId,
      tags: options.tags,
      metadata: options.metadata,
    },
    () =>
      startActiveObservation(
        name,
        async (span) => {
          try {
            span.update({
              input: options.input,
              metadata: options.metadata,
            });

            const result = await fn(span);
            span.update({ output: result });
            return result;
          } catch (err) {
            span.update({
              level: "ERROR",
              statusMessage: err instanceof Error ? err.message : String(err),
              output: { error: err instanceof Error ? err.message : String(err) },
            });
            throw err;
          }
        },
        { asType: "span" },
      ),
  );
}

export interface GenerationTraceResult {
  output: unknown;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Trace an LLM generation observation with model, input messages, output, and token usage.
 */
export async function traceGeneration<T extends GenerationTraceResult>(
  name: string,
  options: {
    model?: string;
    input: unknown;
    metadata?: Record<string, unknown>;
  },
  fn: (gen: LangfuseGeneration | null) => Promise<T>,
): Promise<T> {
  if (!enabled) {
    return fn(null);
  }

  return startActiveObservation(
    name,
    async (gen) => {
      try {
        gen.update({
          model: options.model,
          input: options.input,
          metadata: options.metadata,
        });

        const result = await fn(gen);

        gen.update({
          output: result.output,
          usageDetails: result.usage
            ? {
                input: result.usage.promptTokens ?? 0,
                output: result.usage.completionTokens ?? 0,
                total:
                  result.usage.totalTokens ??
                  (result.usage.promptTokens ?? 0) + (result.usage.completionTokens ?? 0),
              }
            : undefined,
          metadata: result.metadata ? { ...options.metadata, ...result.metadata } : options.metadata,
        });

        return result;
      } catch (err) {
        gen.update({
          level: "ERROR",
          statusMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    { asType: "generation" },
  );
}

export interface ToolTraceOptions {
  input: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Trace a tool/data retrieval observation (e.g. MongoDB query execution or overview compilation).
 */
export async function traceTool<T>(
  name: string,
  options: ToolTraceOptions,
  fn: (span: LangfuseSpan | null) => Promise<T>,
): Promise<T> {
  if (!enabled) {
    return fn(null);
  }

  return startActiveObservation(
    name,
    async (toolSpan) => {
      try {
        toolSpan.update({
          input: options.input,
          metadata: options.metadata,
        });

        const result = await fn(toolSpan);
        toolSpan.update({ output: result });
        return result;
      } catch (err) {
        toolSpan.update({
          level: "ERROR",
          statusMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    { asType: "tool" },
  );
}

/**
 * Force flush pending spans to Langfuse Cloud.
 * Essential before serverless function exits or request completes.
 */
export async function flushTelemetry(): Promise<void> {
  if (spanProcessor) {
    try {
      await spanProcessor.forceFlush();
    } catch (err) {
      console.warn("[leadpulse/telemetry] Error flushing traces to Langfuse:", err);
    }
  }
  // Flushed separately, and failures are swallowed separately: a LangSmith
  // outage must not cost us the Langfuse trace, or vice versa.
  if (langsmith) {
    try {
      await langsmith.processor.forceFlush();
    } catch (err) {
      console.warn("[leadpulse/telemetry] Error flushing traces to LangSmith:", err);
    }
  }
}

/** Which backends this process is exporting to. For diagnostics. */
export function telemetryDestinations(): { langfuse: boolean; langsmith: string | null } {
  return { langfuse: enabled, langsmith: langsmith ? `${langsmith.endpoint} (${langsmith.project})` : null };
}

/* -------------------------------------------------------------------------- */
/* Joining a trace that started somewhere else                                 */
/* -------------------------------------------------------------------------- */

const remotePropagator = new W3CTraceContextPropagator();

/**
 * Runs `fn` inside the trace its caller sent in the `traceparent` header.
 *
 * The eval runner (`scripts/eval_langfuse.mjs`) opens a span per dataset item
 * in Node and then calls the Worker to do the actual planning. Without this the
 * planner's spans would start a second, unconnected trace, and the Langfuse
 * experiment item would link to a trace with nothing in it. With it, the
 * `analyst-plan` generation lands underneath the item's own span, so the
 * experiment view drills straight down into the prompt and the tokens.
 *
 * No header, or telemetry off, and this is a plain call - nothing to join.
 */
export function withRemoteTrace<T>(headers: Headers, fn: () => T): T {
  if (!enabled) return fn();

  const traceparent = headers.get("traceparent");
  if (!traceparent) return fn();

  const carrier: Record<string, string> = { traceparent };
  const tracestate = headers.get("tracestate");
  if (tracestate) carrier.tracestate = tracestate;

  const ctx = remotePropagator.extract(api.context.active(), carrier, {
    get: (c, key) => (c as Record<string, string>)[key],
    keys: (c) => Object.keys(c as Record<string, string>),
  });

  return api.context.with(ctx, fn);
}

/** The id of the trace currently being recorded, for handing back to a caller. */
export function activeTraceId(): string | null {
  const id = api.trace.getActiveSpan()?.spanContext().traceId;
  return id && !/^0+$/.test(id) ? id : null;
}
