/**
 * Starts both halves of the app and keeps their output separate.
 *
 * `wrangler dev` runs the Worker with the real Durable Object bindings and the
 * MongoDB driver; Vite serves the React app and proxies `/api` to it. Killing
 * this process kills both.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

// Load .dev.vars so wrangler dev and child processes inherit Cloudflare API credentials
if (existsSync(".dev.vars")) {
  for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length > 1 && (value.at(0) === '"' || value.at(0) === "'") && value.at(-1) === value.at(0)) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// `wrangler dev` refuses to start if `assets.directory` is missing, and on a
// fresh clone it is - the real UI comes from Vite in dev, and `dist/` only
// exists after a build. A placeholder keeps the Worker startable; `npm run
// build` overwrites it.
if (!existsSync("dist/index.html")) {
  mkdirSync("dist", { recursive: true });
  writeFileSync("dist/index.html", "<!doctype html><title>LeadPulse</title><p>Run npm run build.</p>");
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const procs = [
  { name: "worker", tint: "\u001b[36m", args: ["wrangler", "dev", "--port", "8787"] },
  { name: "ui    ", tint: "\u001b[35m", args: ["vite"] },
].map(({ name, tint, args }) => {
  const child = spawn(npx, args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const write = (stream) => (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) stream.write(`${tint}${name}\u001b[0m  ${line}\n`);
    }
  };
  child.stdout.on("data", write(process.stdout));
  child.stderr.on("data", write(process.stderr));
  return child;
});

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", stop);
