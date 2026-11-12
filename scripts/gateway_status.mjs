/**
 * Asks the LLM gateway what it is pointing at.
 *
 * When the agent stops answering, the first question is always which hop broke:
 * the gateway, the notebook's tunnel, or Ollama itself. Hitting `/__status` by
 * hand means reassembling the URL and the bearer token from `.dev.vars` every
 * time, so this does that and reports the three states separately.
 *
 *   npm run gateway:status
 */

import { readFile } from "node:fs/promises";

/** Parses `.dev.vars` the same way wrangler does: KEY=VALUE, `#` comments, no interpolation. */
async function readDevVars(path = ".dev.vars") {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`cannot read ${path} - run this from the repo root`);
  }
  const vars = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return vars;
}

const vars = await readDevVars();
const base = (vars.LLM_BASE_URL ?? "").replace(/\/+$/, "");
const token = vars.LLM_API_KEY ?? "";

if (!base) {
  console.error("LLM_BASE_URL is not set in .dev.vars - nothing to check.");
  process.exit(1);
}
if (!base.includes(".workers.dev")) {
  console.error(
    `LLM_BASE_URL is ${base}, which is not the gateway.\n` +
      "This script only understands the gateway in gateway/README.md.",
  );
  process.exit(1);
}

async function get(path, withAuth) {
  const res = await fetch(`${base}${path}`, {
    headers: withAuth ? { authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: res.status, body };
}

console.log(`gateway: ${base}`);

const health = await get("/__health", false).catch((err) => ({ status: 0, body: String(err) }));
if (health.status !== 200) {
  console.log(`  down or not deployed (HTTP ${health.status})`);
  console.log(`  ${JSON.stringify(health.body)}`);
  process.exit(1);
}
console.log("  gateway:  up");

if (!token) {
  // `/__health` is all that can be read without the token, and its view of
  // whether anything is registered can be up to a minute stale - see the KV
  // note in gateway/README.md.
  console.log(
    health.body.upstreamRegistered
      ? `  notebook: registered ~${health.body.registeredMinutesAgo} min ago ` +
          "(set LLM_API_KEY in .dev.vars for the rest)"
      : "  notebook: nothing registered - run the tunnel cell in the notebook",
  );
  process.exit(health.body.upstreamRegistered ? 0 : 1);
}

const status = await get("/__status", true);
if (status.status === 401) {
  console.log("  auth:     rejected - LLM_API_KEY does not match the Worker's GATEWAY_TOKEN");
  process.exit(1);
}
if (!status.body?.upstream) {
  console.log("  notebook: nothing registered - run the tunnel cell in the notebook");
  process.exit(1);
}
console.log(`  upstream: ${status.body.upstream}`);
console.log(`  heard from notebook: ${status.body.registeredMinutesAgo} min ago`);

// The notebook re-registers every 10 minutes as a liveness beat, so anything
// much older than that means the session ended rather than the model being busy.
if (status.body.registeredMinutesAgo > 25) {
  console.log("  warning:  that is stale - the notebook session has probably ended");
}

const tags = await get("/api/tags", true);
if (tags.status !== 200) {
  console.log(`  model:    unreachable (HTTP ${tags.status})`);
  console.log(`  ${JSON.stringify(tags.body)}`);
  process.exit(1);
}
const models = (tags.body.models ?? []).map((m) => m.name);
console.log(`  model:    reachable - ${models.join(", ") || "no models pulled"}`);
console.log(`  expected: ${vars.LLM_MODEL ?? "(LLM_MODEL unset)"}`);
if (vars.LLM_MODEL && !models.includes(vars.LLM_MODEL)) {
  console.log("  warning:  LLM_MODEL is not among the models the notebook pulled");
}
