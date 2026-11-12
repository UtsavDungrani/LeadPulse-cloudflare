# `leadpulse-llm` — a permanent address for the notebook model

The model runs on a free GPU in a Colab/Kaggle notebook, behind
`cloudflared tunnel --url`. That is a **quick tunnel**, and a quick tunnel is
anonymous: Cloudflare mints a throwaway `*.trycloudflare.com` hostname each time
the process starts and reclaims it when the process stops. So every notebook
session produced a new URL to paste into `.dev.vars` — and a *deployed* Worker
could not be repointed from the notebook at all.

This Worker is the fixed address instead:

```
app  ──►  https://leadpulse-llm.20230905090503u.workers.dev  ──►  https://<random>.trycloudflare.com  ──►  ollama :11434
          (never changes; what LLM_BASE_URL is set to)            (changes every session; stored in KV)
```

The notebook posts its new tunnel URL to `/__register` on startup, the Worker
keeps it in KV, and everything else it receives is streamed through. `.dev.vars`
is edited once, ever.

## What "permanent" means here

The **URL** is permanent. The **uptime** is not, and nothing free can make it:
Colab and Kaggle stop a session after a few hours and on idle, and when the
notebook stops the model is gone. What this removes is the busywork and the
stale-config failures, not the session limit. While nothing is registered or the
tunnel is dead, calls fail fast with a 502/503 that says which it is, instead of
hanging or returning a Cloudflare HTML error page.

Why not a Cloudflare **named** tunnel, which is the documented way to pin a
hostname for good? It needs a DNS record in a Cloudflare zone, and this account
has no domain on it. Buy any cheap domain, add it to Cloudflare, and the named
tunnel becomes the better answer — see the bottom of this file.

## One-time setup

```bash
npx wrangler secret put GATEWAY_TOKEN -c gateway/wrangler.jsonc
```

```bash
npm run deploy:gateway
```

Then store the same two values as notebook secrets (Colab: the key icon in the
sidebar, with "Notebook access" enabled; Kaggle: Add-ons → Secrets):

| Secret              | Value                                    |
| ------------------- | ---------------------------------------- |
| `LLM_GATEWAY_TOKEN` | the same string given to `GATEWAY_TOKEN` |

That is the only one required. The gateway's address is baked into the notebook,
since it is useless to anyone without the token; set an optional
`LLM_GATEWAY_URL` secret only if this Worker ever moves.

On Kaggle, creating the secret is not enough — **attach it to the notebook** in
the same dialog, and turn Internet on. A prompt for the token when Step 4 runs
is what a missing attachment looks like.

Finally, run the notebook. [`ollama_tunnel.ipynb`](ollama_tunnel.ipynb) is the
whole thing, ready to upload to Colab or Kaggle — GPU check, install, Ollama,
model pull, register, watchdog. To patch the existing
`ollama_colab_tunnel.ipynb` in place instead, Steps 0–3 are unchanged and
[`notebook_tunnel_cell.py`](notebook_tunnel_cell.py) replaces Steps 4 and 5.

## Using it

`.dev.vars` (and `wrangler secret put` for the deployed app):

```
LLM_BASE_URL=https://leadpulse-llm.20230905090503u.workers.dev
LLM_MODEL=qwen2.5:32b
LLM_API_KEY=<the GATEWAY_TOKEN>
```

`LLM_MODEL` has to name a model the notebook actually pulled. Worth checking:
`.dev.vars` asks for `qwen2.5:32b`, while `ollama_colab_tunnel.ipynb` Step 3
pulls `qwen2.5:7b` — if that is the notebook serving this app, one of the two
needs changing, and `npm run gateway:status` says which models are really there.

`src/llm/openaicompat.ts` appends `/v1` itself, so the bare origin is correct
here. `LLM_API_KEY` is already sent as a bearer token by that adapter, which is
why the gateway reuses that header rather than inventing one.

For the other project pointing at the same notebook, `OLLAMA_API_BASE` takes the
same URL — but its client must send `Authorization: Bearer <token>` too, since
the gateway authenticates every path.

## Endpoints

| Path          | Auth | Purpose                                                           |
| ------------- | ---- | ----------------------------------------------------------------- |
| `/__health`   | no   | Is the gateway up, is anything registered, how long ago. No URL.  |
| `/__status`   | yes  | The registered tunnel URL and its age.                            |
| `/__register` | yes  | `POST {"url": "https://...trycloudflare.com"}` — the notebook's job. |
| everything else | yes | Streamed through to the notebook (`/v1/chat/completions`, `/api/tags`, …). |

Check it by hand:

```bash
curl -s https://leadpulse-llm.20230905090503u.workers.dev/__health
```

```bash
curl -s -H "Authorization: Bearer $GATEWAY_TOKEN" https://leadpulse-llm.20230905090503u.workers.dev/__status
```

## Why the token

A `trycloudflare.com` URL is unauthenticated — anyone who sees it in a log or a
screenshot can spend the GPU, and the model will happily answer them. Routing
through the gateway lets one shared token gate both registering and calling. The
token never reaches Ollama: it is stripped from the request before it is
forwarded, because Ollama expects no auth and would reject nothing anyway.

Rotate it by running `wrangler secret put GATEWAY_TOKEN` again and updating the
notebook secret and `LLM_API_KEY`.

## Notes and limits

- **Streaming is load-bearing, but it does not cover a cold model.** Cloudflare
  aborts a request that produces no response byte for ~100 seconds, at both
  hops. SSE keeps *generation* inside that budget — the first token arrives
  early and the rest can take as long as it likes. It does nothing for the
  minutes Ollama spends loading a 20 GB model into VRAM, because no token
  exists yet to stream. Measured on this setup: a cold `qwen2.5:32b` returned a
  524 after ~125s; the same call once resident answered in 14s. So the notebook
  sets `OLLAMA_KEEP_ALIVE=-1` and warms the model before the tunnel is
  registered. A 524 whose body is a `trycloudflare.com` error page means the
  model was evicted — not that the gateway is broken.
- **A dead tunnel is reported, not relayed.** A stopped quick tunnel still
  resolves — Cloudflare answers for the hostname with 530/1033 and an HTML
  page — so the gateway translates a 530 into the same 502 JSON an
  unresolvable tunnel gets, naming the registered URL and how long ago the
  notebook last checked in. Over ~15 minutes with a 10-minute heartbeat means
  the watch cell (Step 5) is not running.
- **A registration can take up to a minute to take effect.** KV reads are
  cached at the edge for 60 seconds, so just after the notebook registers a
  *new* tunnel the gateway may still forward to the old one and answer 502. It
  clears itself within the minute; it is only visible when the watchdog replaces
  a dropped tunnel mid-session, never on a cold start with nothing registered.
- **Send a real User-Agent.** Cloudflare's edge bot rules answer 403 to some
  default library agents before the Worker is reached — measured against this
  deployment, `Python-urllib/3` is blocked and `python-requests` is not. The
  notebook therefore sets its own `User-Agent`, and any new client should too;
  a 403 with no JSON body in it is the edge, not the gateway.
- **KV write budget.** The free tier allows 1,000 writes/day per account. The
  notebook writes on start, on tunnel restart, and once per 10 minutes as a
  liveness heartbeat — roughly 150/day per notebook.
- **Requests.** The Workers free tier covers 100,000 requests/day, which a
  handful of agent sessions will not approach.

## The upgrade path

If a domain ever lands in this Cloudflare account, a named tunnel is simpler
than this Worker and removes a hop:

```bash
cloudflared tunnel login
```

```bash
cloudflared tunnel create notebook-llm
```

```bash
cloudflared tunnel route dns notebook-llm llm.example.com
```

The notebook then runs `cloudflared tunnel run --token <tunnel token>` and
`llm.example.com` points at it every session with no registration step. The
tunnel and the DNS are free; only the domain costs anything. Cloudflare Access
can then sit in front of it instead of the bearer token here.
