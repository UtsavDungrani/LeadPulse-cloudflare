#!/usr/bin/env node
/**
 * Runs the golden set against the live planner and records it in LangSmith.
 *
 *   npm run dev            # in another terminal
 *   npm run eval:langsmith
 *
 * Each test case creates a root trace that propagates through to the Worker's
 * planner via the `traceparent` header, allowing LangSmith to capture full
 * call traces, prompt inputs, models, tokens, and eval metrics.
 */
import { readFileSync } from "node:fs";
import api from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const WORKER = process.env.EVAL_WORKER_URL ?? "http://127.0.0.1:8787";
const PROJECT = process.env.LANGSMITH_PROJECT ?? "leadpulse";
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 3);

function loadDevVars(path = ".dev.vars") {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length > 1 && (value.at(0) === '"' || value.at(0) === "'") && value.at(-1) === value.at(0)) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDevVars();

const apiKey = process.env.LANGSMITH_API_KEY;
const endpoint = (process.env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com/otel").replace(/\/+$/, "");

if (!apiKey) {
  console.error("LANGSMITH_API_KEY must be set in .dev.vars or environment.");
  process.exit(1);
}

const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
api.context.setGlobalContextManager(contextManager);

const exporter = new OTLPTraceExporter({
  url: `${endpoint}/v1/traces`,
  headers: { "x-api-key": apiKey, "Langsmith-Project": PROJECT },
});

const spanProcessor = new SimpleSpanProcessor(exporter);
const provider = new BasicTracerProvider({ spanProcessors: [spanProcessor] });
api.trace.setGlobalTracerProvider(provider);

const propagator = new W3CTraceContextPropagator();
const tracer = api.trace.getTracer("leadpulse-eval-langsmith");

function traceHeaders() {
  const carrier = {};
  propagator.inject(api.context.active(), carrier, {
    set: (c, k, v) => {
      c[k] = v;
    },
  });
  return carrier;
}

async function fetchCases() {
  const res = await fetch(`${WORKER}/api/eval/cases`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(
      `GET ${WORKER}/api/eval/cases failed (${res.status}): ${body.error ?? "no body"}. ` +
        `Is "npm run dev" running, with EVALS_ENABLED="true" in .dev.vars?`,
    );
  }
  return body;
}

async function runOne(item) {
  return tracer.startActiveSpan(
    `eval:${item.id}`,
    {
      attributes: {
        "langsmith.span.kind": "chain",
        "langsmith.trace.name": `eval:${item.id}`,
        "langsmith.span.tags": "eval,langsmith-golden",
        "input.value": JSON.stringify({ question: item.question, expectedKind: item.expectedKind }),
        "langsmith.metadata.caseId": item.id,
      },
    },
    async (span) => {
      try {
        const headers = { "Content-Type": "application/json", ...traceHeaders() };
        const res = await fetch(`${WORKER}/api/eval/run`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: item.id }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          throw new Error(`Worker returned ${res.status}: ${body.error ?? "unknown error"}`);
        }

        span.setAttribute("output.value", JSON.stringify(body));
        span.setAttribute("langsmith.metadata.pass", body.pass ? "true" : "false");
        span.setAttribute("langsmith.metadata.latencyMs", body.latencyMs);

        return body;
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: api.SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

async function pool(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function report(rows) {
  const failed = rows.filter((r) => !r.pass);
  const queries = rows.filter((r) => r.expectedKind === "query");
  const refusals = rows.filter((r) => r.expectedKind === "refusal");
  const share = (arr) => (arr.length ? arr.filter((r) => r.pass).length / arr.length : 0);
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const bar = "=".repeat(72);

  console.log(`\n${bar}`);
  console.log(`LANGSMITH EVAL REPORT: ${PROJECT}`);
  console.log(`${bar}`);
  console.log(`intent accuracy    ${pct(share(rows))}  (${rows.filter((r) => r.pass).length}/${rows.length})`);
  console.log(`  answerable       ${pct(share(queries))}  (${queries.filter((r) => r.pass).length}/${queries.length})`);
  console.log(`  refusals         ${pct(share(refusals))}  (${refusals.filter((r) => r.pass).length}/${refusals.length})`);
  console.log(`${bar}\n`);

  if (failed.length) {
    console.log(`${failed.length} failing case${failed.length === 1 ? "" : "s"}:\n`);
    for (const f of failed) {
      console.log(`  [FAIL] ${f.id}`);
      console.log(`    q: ${f.question}`);
      console.log(`    reason: ${f.reason}`);
    }
  } else {
    console.log("All golden cases passed!");
  }
}

async function main() {
  console.log(`Connecting to ${WORKER} for golden set cases...`);
  const { cases, meta } = await fetchCases();
  console.log(`Running ${cases.length} cases (concurrency: ${CONCURRENCY})...`);

  const results = await pool(
    cases,
    async (item, idx) => {
      const result = await runOne(item);
      const icon = result.pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
      console.log(`[${idx + 1}/${cases.length}] ${icon} ${item.id} (${result.latencyMs}ms)`);
      return result;
    },
    CONCURRENCY,
  );

  report(results);

  console.log("Flushing traces to LangSmith...");
  await spanProcessor.forceFlush();
  console.log("Done! Traces recorded in LangSmith project:", PROJECT);
}

main().catch((err) => {
  console.error("Eval run failed:", err);
  process.exit(1);
});

