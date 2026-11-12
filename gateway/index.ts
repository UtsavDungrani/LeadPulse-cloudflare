/**
 * A permanent front door for the Ollama server that runs in a Colab/Kaggle
 * notebook.
 *
 * The problem this solves: `cloudflared tunnel --url ...` creates a *quick*
 * tunnel, and a quick tunnel's hostname is assigned fresh every time it starts.
 * A notebook session dies after a few hours, so every restart hands out a new
 * `*.trycloudflare.com` name that has to be pasted into `.dev.vars` by hand -
 * and a deployed Worker cannot be edited from the notebook at all.
 *
 * The permanent fix Cloudflare documents for this is a *named* tunnel, which
 * pins a hostname for good. It needs a domain in the account to hang that
 * hostname on, and this account has no zone - so instead this Worker becomes
 * the stable name. It lives at a `workers.dev` hostname that never changes, and
 * it keeps the current quick-tunnel URL in KV:
 *
 *   notebook starts -> cloudflared prints a new random URL
 *                   -> notebook POSTs it to /__register
 *                   -> this Worker proxies every other path to it
 *
 * So `LLM_BASE_URL` is set once and never touched again. What is permanent here
 * is the *address*, not the uptime: the notebook still stops when its session
 * ends, and requests then fail with a 502 that says so rather than hanging.
 *
 * It also closes a hole the bare tunnel left open. A `trycloudflare.com` URL is
 * unauthenticated - anyone who learns it can spend the GPU. Every path here
 * requires the shared bearer token, which the app already sends as
 * `LLM_API_KEY`, and the token is stripped before the request goes upstream
 * because Ollama wants no auth of its own.
 */

export interface Env {
  /** Holds the one registration record. */
  UPSTREAM: KVNamespace;
  /** Shared secret: the notebook registers with it, callers proxy with it. */
  GATEWAY_TOKEN: string;
}

interface Registration {
  /** Origin of the live quick tunnel, e.g. `https://odd-cat-42.trycloudflare.com`. */
  url: string;
  /** Epoch ms, so a stale pointer can be reported as an age. */
  registeredAt: number;
  /** Free-text marker from the notebook, e.g. the model it pulled. */
  note?: string;
}

const KEY = "upstream";

/**
 * Headers that describe one hop and must not be copied to the next, plus the
 * Cloudflare-added request metadata. `authorization` is on the list because the
 * token authenticates the caller to *this* Worker and means nothing to Ollama;
 * `accept-encoding` because the runtime manages compression per hop itself, and
 * forwarding the client's value produces a body the client cannot read.
 */
const STRIP_FROM_REQUEST = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "accept-encoding",
  "content-length",
  "cf-connecting-ip",
  "cf-ray",
  "cf-ipcountry",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]);

/**
 * Same idea on the way back. `content-length` goes because the body is streamed
 * through and the length the origin claimed may not survive re-framing.
 */
const STRIP_FROM_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

/**
 * Compares the presented token with the configured one without leaking where
 * they first differ. A length mismatch still returns early - that reveals only
 * the length, and a guess that far off is not the attack worth defending here.
 */
function tokenMatches(presented: string, expected: string): boolean {
  if (!presented || !expected || presented.length !== expected.length) return false;
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Accepts `Authorization: Bearer <token>` and a bare token, which curl users send. */
function authorized(req: Request, env: Env): boolean {
  const header = req.headers.get("authorization") ?? "";
  const presented = header.replace(/^bearer\s+/i, "");
  return tokenMatches(presented.trim(), env.GATEWAY_TOKEN ?? "");
}

/**
 * Guards what the notebook is allowed to point this Worker at.
 *
 * Without this check a leaked token would turn the gateway into an open relay
 * that borrows the Worker's network position - so the target must be a public
 * HTTPS origin, never a name that resolves inside a private network or to a
 * cloud metadata endpoint.
 */
function validateUpstream(raw: string): { ok: true; origin: string } | { ok: false; why: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, why: `not a URL: ${raw}` };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, why: "the upstream must be https - a quick tunnel always is" };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, why: `refusing a non-public host: ${host}` };
  }
  if (
    host === "localhost" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return { ok: false, why: `refusing a private address: ${host}` };
  }
  return { ok: true, origin: parsed.origin };
}

async function readRegistration(env: Env): Promise<Registration | null> {
  return await env.UPSTREAM.get<Registration>(KEY, "json");
}

function minutesSince(ms: number): number {
  return Math.round((Date.now() - ms) / 60_000);
}

async function register(req: Request, env: Env): Promise<Response> {
  let body: { url?: string; note?: string };
  try {
    body = (await req.json()) as { url?: string; note?: string };
  } catch {
    return json({ error: 'expected a JSON body like {"url":"https://..."}' }, 400);
  }
  if (!body.url) return json({ error: 'missing "url"' }, 400);

  const checked = validateUpstream(body.url);
  if (!checked.ok) return json({ error: checked.why }, 400);

  const record: Registration = {
    url: checked.origin,
    registeredAt: Date.now(),
    ...(body.note ? { note: body.note } : {}),
  };
  await env.UPSTREAM.put(KEY, JSON.stringify(record));
  return json({
    ok: true,
    registered: record.url,
    at: new Date(record.registeredAt).toISOString(),
  });
}

/**
 * Streams one request through to the notebook.
 *
 * The body is passed by reference rather than buffered, in both directions:
 * a 7B model answering a retrieval-sized prompt takes longer than the 100
 * seconds Cloudflare allows before the first byte, and the app asks for SSE
 * precisely so that the first token arrives inside that window. Buffering here
 * would reintroduce the HTTP 524 the streaming was added to avoid.
 */
async function proxy(req: Request, env: Env, reg: Registration): Promise<Response> {
  const incoming = new URL(req.url);
  const target = new URL(reg.url);
  target.pathname = incoming.pathname;
  target.search = incoming.search;

  const headers = new Headers();
  for (const [name, value] of req.headers) {
    if (!STRIP_FROM_REQUEST.has(name.toLowerCase())) headers.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
    });
  } catch (err) {
    // The common case by far: the notebook session ended, so the tunnel it
    // registered no longer resolves. Say that plainly - the adapter in
    // src/llm/openaicompat.ts surfaces this text, and "fetch failed" would send
    // the reader looking for a bug in the app.
    return json(
      {
        error: "the notebook behind this gateway is not reachable",
        detail: err instanceof Error ? err.message : String(err),
        registeredUrl: reg.url,
        registeredMinutesAgo: minutesSince(reg.registeredAt),
        fix: "re-run the tunnel cell in ollama_colab_tunnel.ipynb to register a fresh URL",
      },
      502,
    );
  }

  // A quick tunnel that has stopped still resolves - Cloudflare's edge answers
  // for the hostname and reports 530/1033, "origin unreachable". That is a
  // successful fetch as far as the runtime is concerned, so it would otherwise
  // be relayed verbatim: an HTML error page, with the real cause (the notebook
  // is gone) nowhere in it. Translate it into the same answer an unresolvable
  // tunnel gets, since to a caller it is the same failure.
  if (upstream.status === 530) {
    return json(
      {
        error: "the notebook behind this gateway is not reachable",
        detail: "the registered tunnel is no longer running (Cloudflare 530/1033)",
        registeredUrl: reg.url,
        registeredMinutesAgo: minutesSince(reg.registeredAt),
        fix:
          minutesSince(reg.registeredAt) > 15
            ? "the notebook has not checked in for a while - re-run Steps 4 and 5 of ollama_tunnel.ipynb"
            : "the tunnel restarted; its new address should register within a minute",
      },
      502,
    );
  }

  const out = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!STRIP_FROM_RESPONSE.has(name.toLowerCase())) out.set(name, value);
  }
  for (const [name, value] of Object.entries(CORS)) out.set(name, value);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.GATEWAY_TOKEN) {
      return json({ error: "GATEWAY_TOKEN is not set on this Worker - see gateway/README.md" }, 500);
    }

    const { pathname } = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Unauthenticated on purpose, and deliberately thin: enough to tell "the
    // gateway is up but nothing is registered" from "the gateway is down"
    // without disclosing the tunnel URL to whoever asks.
    if (pathname === "/__health") {
      const reg = await readRegistration(env);
      return json({
        ok: true,
        upstreamRegistered: reg !== null,
        ...(reg ? { registeredMinutesAgo: minutesSince(reg.registeredAt) } : {}),
      });
    }

    if (!authorized(req, env)) {
      return json({ error: "unauthorized - send Authorization: Bearer <GATEWAY_TOKEN>" }, 401);
    }

    if (pathname === "/__register" && (req.method === "POST" || req.method === "PUT")) {
      return await register(req, env);
    }

    if (pathname === "/__status") {
      const reg = await readRegistration(env);
      if (!reg) return json({ upstream: null });
      return json({
        upstream: reg.url,
        registeredAt: new Date(reg.registeredAt).toISOString(),
        registeredMinutesAgo: minutesSince(reg.registeredAt),
        ...(reg.note ? { note: reg.note } : {}),
      });
    }

    const reg = await readRegistration(env);
    if (!reg) {
      return json(
        {
          error: "no notebook has registered a tunnel with this gateway yet",
          fix: "run the tunnel cell in ollama_colab_tunnel.ipynb",
        },
        503,
      );
    }

    return await proxy(req, env, reg);
  },
} satisfies ExportedHandler<Env>;
