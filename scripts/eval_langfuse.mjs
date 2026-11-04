#!/usr/bin/env node
/**
 * Runs the golden set against the live planner and records it in Langfuse as
 * an experiment.
 *
 * Why it is a script and not a test: the planner needs the Workers AI binding,
 * which only exists inside the Worker, so the model half of
 * `src/evals/__tests__/intent.eval.test.ts` has always skipped itself. The
 * planning therefore happens in the Worker (`src/evals/route.ts`) and the
 * orchestration happens here.
 *
 *   npm run dev            # in another terminal - this script needs the Worker
 *   npm run eval:langfuse
 *
 * What it reports, per run:
 *   intent_match     per case, boolean - did it compile to the expected pipeline
 *   refusal_correct  per refusal case, boolean - did it decline
 *   plan_latency_ms  per case, numeric
 *   intent_accuracy  per run, the headline number
 *   query_accuracy / refusal_accuracy  per run, split because the two failures
 *                    are not equally bad: a wrong pipeline is a bad answer,
 *                    inventing one for data we do not have is the expensive one
 *
 * The Worker's planning spans are pulled into this script's trace through the
 * `traceparent` header, so each experiment item drills down into the real
 * prompt, model and token counts rather than sitting next to them.
 */
import { readFileSync } from "node:fs";
import api from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { LangfuseClient } from "@langfuse/client";

const WORKER = process.env.EVAL_WORKER_URL ?? "http://127.0.0.1:8787";
const DATASET = process.env.EVAL_DATASET ?? "leadpulse-intent-golden";
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 3);

/* -- config ---------------------------------------------------------------- */

/** Reads `.dev.vars` the way wrangler does, without overriding a real env var. */
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

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
const baseUrl = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";

if (!publicKey || !secretKey) {
  console.error("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set (.dev.vars).");
  process.exit(1);
}

/* -- tracing --------------------------------------------------------------- */

const spanProcessor = new LangfuseSpanProcessor({
  publicKey,
  secretKey,
  baseUrl,
  exportMode: "immediate",
});

const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
api.context.setGlobalContextManager(contextManager);

const provider = new BasicTracerProvider({ spanProcessors: [spanProcessor] });
api.trace.setGlobalTracerProvider(provider);
setLangfuseTracerProvider(provider);

const propagator = new W3CTraceContextPropagator();

/** The headers that let the Worker put its spans inside this item's trace. */
function traceHeaders() {
  const carrier = {};
  propagator.inject(api.context.active(), carrier, {
    set: (c, k, v) => {
      c[k] = v;
    },
  });
  return carrier;
}

/* -- the run --------------------------------------------------------------- */

const client = new LangfuseClient({ publicKey, secretKey, baseUrl });

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

/** Idempotent: the dataset is keyed by name and the items upsert on their id. */
async function syncDataset(cases, meta) {
  try {
    await client.api.datasets.create({
      name: DATASET,
      description:
        "Question -> expected compiled pipeline, or an expected refusal. Graded on the " +
        "compiled MongoDB pipeline rather than the intent object, so two intents that " +
        "differ cosmetically but ask the database the same thing both pass.",
      metadata: { source: "src/evals/golden.ts", today: meta.today, dataWindow: meta.dataWindow },
    });
  } catch (err) {
    // Creating an existing dataset is how this script stays re-runnable.
    if (!/already exists|409/i.test(String(err))) throw err;
  }

  for (const c of cases) {
    await client.api.datasetItems.create({
      datasetName: DATASET,
      id: `golden-${c.id}`,
      input: { question: c.question, previous: c.previous },
      expectedOutput: c.expected,
      metadata: { caseId: c.id, note: c.note, kind: c.expected.kind },
    });
  }
}

/** One case: hand it to the Worker, which plans it and grades it. */
const task = async ({ metadata }) => {
  const caseId = metadata?.caseId;
  const res = await fetch(`${WORKER}/api/eval/run`, {
    method: "POST",
    headers: { "content-type": "application/json", ...traceHeaders() },
    body: JSON.stringify({ id: caseId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(`case ${caseId}: worker ${res.status} ${body.error ?? ""}`);
  }
  return body;
};

const evaluators = [
  async ({ output }) => {
    const scores = [
      {
        name: "intent_match",
        value: output.pass ? 1 : 0,
        dataType: "BOOLEAN",
        comment: output.reason,
      },
      { name: "plan_latency_ms", value: output.latencyMs, dataType: "NUMERIC" },
    ];
    // Only meaningful where a refusal was the right answer; scoring it on every
    // case would bury the six that actually test it.
    if (output.expectedKind === "refusal") {
      scores.push({
        name: "refusal_correct",
        value: output.actualKind === "refusal" ? 1 : 0,
        dataType: "BOOLEAN",
        comment: output.reason,
      });
    }
    return scores;
  },
];

const share = (rows) => (rows.length ? rows.filter((r) => r.pass).length / rows.length : 0);

const runEvaluators = [
  async ({ itemResults }) => {
    const rows = itemResults.map((r) => r.output).filter(Boolean);
    const queries = rows.filter((r) => r.expectedKind === "query");
    const refusals = rows.filter((r) => r.expectedKind === "refusal");
    const latencies = rows.map((r) => r.latencyMs).filter((n) => typeof n === "number");
    latencies.sort((a, b) => a - b);

    return [
      {
        name: "intent_accuracy",
        value: share(rows),
        dataType: "NUMERIC",
        comment: `${rows.filter((r) => r.pass).length}/${rows.length} cases`,
      },
      {
        name: "query_accuracy",
        value: share(queries),
        dataType: "NUMERIC",
        comment: `${queries.filter((r) => r.pass).length}/${queries.length} answerable questions`,
      },
      {
        name: "refusal_accuracy",
        value: share(refusals),
        dataType: "NUMERIC",
        comment: `${refusals.filter((r) => r.pass).length}/${refusals.length} unanswerable questions`,
      },
      {
        name: "plan_latency_p50_ms",
        value: latencies[Math.floor(latencies.length / 2)] ?? 0,
        dataType: "NUMERIC",
      },
    ];
  },
];

function report(result) {
  const rows = (result.itemResults ?? []).map((r) => r.output).filter(Boolean);
  const failed = rows.filter((r) => !r.pass);
  const queries = rows.filter((r) => r.expectedKind === "query");
  const refusals = rows.filter((r) => r.expectedKind === "refusal");
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const bar = "=".repeat(72);

  console.log(`\n${bar}`);
  console.log(
    `intent accuracy    ${pct(share(rows))}  (${rows.filter((r) => r.pass).length}/${rows.length})`,
  );
  console.log(
    `  answerable       ${pct(share(queries))}  (${queries.filter((r) => r.pass).length}/${queries.length})`,
  );
  console.log(
    `  refusals         ${pct(share(refusals))}  (${refusals.filter((r) => r.pass).length}/${refusals.length})`,
  );
  console.log(bar);

  if (failed.length) {
    console.log(`\n${failed.length} failing case${failed.length === 1 ? "" : "s"}:\n`);
    for (const f of failed) {
      console.log(`  ${f.id}`);
      console.log(`    q: ${f.question}`);
      console.log(`    ${f.reason}`);
      if (f.expectedFingerprint && f.actualFingerprint) {
        const e = JSON.parse(f.expectedFingerprint);
        const a = JSON.parse(f.actualFingerprint);
        const diffs = [];
        if (e.grain !== a.grain) diffs.push(`grain ${e.grain} -> ${a.grain}`);
        if (e.compareTo !== a.compareTo) diffs.push(`compareTo ${e.compareTo} -> ${a.compareTo}`);
        if (e.limit !== a.limit) diffs.push(`limit ${e.limit} -> ${a.limit}`);
        if (JSON.stringify(e.parts) !== JSON.stringify(a.parts)) diffs.push("pipeline differs");
        if (diffs.length) console.log(`    ${diffs.join(", ")}`);
      }
      console.log();
    }
  }

  const url = result.experimentUrl ?? result.datasetRunUrl;
  console.log(url ? `Langfuse: ${url}` : `Langfuse: ${baseUrl} -> Datasets -> ${DATASET}`);
}

async function main() {
  const meta = await fetchCases();
  console.log(`golden set: ${meta.cases.length} cases, clock frozen at ${meta.today}`);

  await syncDataset(meta.cases, meta);
  console.log(`dataset "${DATASET}" synced`);

  const dataset = await client.dataset.get(DATASET);
  const runName =
    process.env.EVAL_RUN_NAME ?? `intent-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  console.log(`running "${runName}" against ${WORKER} (concurrency ${CONCURRENCY})...`);

  const result = await client.experiment.run({
    name: "Intent accuracy (golden set)",
    runName,
    description:
      "Does the planner turn each question into the pipeline we expect, and does it " +
      "decline the ones the data cannot answer?",
    data: dataset.items,
    task,
    evaluators,
    runEvaluators,
    maxConcurrency: CONCURRENCY,
  });

  // Spans and scores both buffer; the process must not exit before they land.
  await spanProcessor.forceFlush();
  await client.score.flush();

  report(result);
}

main().catch(async (err) => {
  console.error(`\neval run failed: ${err?.message ?? err}`);
  await spanProcessor.forceFlush().catch(() => {});
  process.exit(1);
});
