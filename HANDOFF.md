# LeadOps Agent — Handoff

Paste this whole file into a new Claude Code session opened at `D:\Projects\leadpulse`.
It is the complete state of the project: what exists, what was decided and why, what is
next, and the traps that are already known.

---

## 1. What we are building

An **agentic revenue-operations copilot** for lead management, on the Cloudflare Agents
SDK with MongoDB as the data store.

Framing: not "chat with your leads table" but **an analyst that works a shift**. It
answers questions on demand, and it also watches the pipeline on a schedule, notices
things, and brings them to you. The proactive half is what justifies the Agents SDK
(Durable Objects + scheduling) over a stateless Worker with one LLM call.

Example asks it must handle: *"report for last week"*, *"conversion by channel this
month vs last"*, *"which rep is sitting on stale leads"*, *"why did conversions drop"*.

---

## 2. Status

| Phase | What | State |
|---|---|---|
| 0 | Data foundry — clean + synthesise + export | **DONE**, imported to local Mongo |
| 1 | Semantic layer + `AnalystAgent` + charts | **DONE** — see §9 |
| 2 | `WatchtowerAgent` (scheduled anomaly detection) | **DONE** — see §10 |
| 3 | `ReportAgent` (cron digests), `LeadDeskAgent` (writes, HITL) | **NEXT** (optional) |

Both agents are complete and tested end to end against the local database.
Not yet built: the React UI, and the model-facing half of the Phase 1 eval has
run structurally but never against the API (no key configured). Details and
exact gaps in §9d and §10g.

---

## 3. The data

### Origin
Kaggle **X Education lead scoring** dataset (`~/Downloads/archive/Leads.csv`), 9,240
rows × 37 cols, 38.5% converted. It is a **flat ML snapshot with no timestamps**, so it
could not answer a single time-based question as shipped.

### What Phase 0 did
`data/phase0_lead_data_foundry.ipynb` (27 cells, runs in Colab, verified end-to-end):

- Cleaned the `"Select"` sentinel (City 24.3%, Specialization 21.0%, "How did you hear"
  54.6% — leave it in and the agent reports *"Select"* as the top city)
- Dropped 5 constant columns; canonicalised `Lead Source` (`Google`/`google` split,
  `testone` record removed, long tail bucketed to `Other`)
- Synthesised `created_at` over a rolling 14-month window; derived `converted_at` from
  channel-specific lognormal lag
- Generated 12 reps, owner assignment, an 8-state pipeline `stage`, a 78k-row activity
  event log, SLA first-response, and daily channel spend
- Quarantined target leakage under `analysis_only`
- Validated 11 invariants and exported MongoDB Extended JSON

### The central design rule — do not break this
**Outcomes are never invented; only timing is synthesised.** Dates are assigned within
`(lead_source, lead_origin, converted)` strata, so every marginal in the original file
survives exactly (asserted in the notebook). Any individual lead's date is meaningless;
the aggregate shape is the point.

### Collections (db `leadpulse`, local `mongodb://localhost:27017/`)

```
leads           9,239 docs   7 indexes
activities     78,425 docs   3 indexes
channel_spend   1,712 docs   2 indexes
reps               12 docs   2 indexes
```

`leads` document shape:

```jsonc
{
  "_id": "<prospect uuid>", "lead_number": 660719,
  "created_at": ISODate, "converted_at": ISODate|null,
  "converted": bool, "days_to_convert": number|null,
  "stage": "New|Attempting|Engaged|Qualified|Won|Lost|Unreachable|Disqualified",
  "is_open": bool, "owner_id": "REP007",
  "lead_origin": "...", "lead_source": "...",
  "engagement": { total_visits, time_on_site_sec, page_views_per_visit, last_activity },
  "profile":    { country, city, specialization, occupation, primary_motivation, heard_from },
  "consent":    { do_not_email, do_not_call, wants_free_copy },
  "sla":        { first_response_minutes, breached },
  "analysis_only": { tags, lead_quality, lead_profile, asym_*, last_notable_activity }
}
```

`activities`: `{ lead_number, ts, actor: "lead"|"rep", type, channel, rep_id, is_last }`
`channel_spend`: `{ day, channel, spend_inr, leads }` — paid channels only
(Google/Facebook/Bing/Other); Organic, Direct, Reference, Olark, Referral Sites are free.
`reps`: `{ _id, name, team, seniority, skill, share, sla_discipline }`

### `analysis_only` is a hard boundary
`tags` literally contains `"Closed by Horizzon"` for 358 won deals; `lead_quality` is a
rep's post-hoc gut call and 51.6% blank. Fine for descriptive BI, **poison for a
predictive model** — you will see 98% accuracy and ship something worthless. Expose the
subtree for reporting; exclude it by path from any feature set.

### `data/foundry/_manifest.json` is the eval answer key
It carries the seed, window, field provenance, and 6 planted incidents — each with
`planted` (what we asked for) **and** `measured` (what the data actually contains).

**Assert evals against `measured`.** They diverge when a segment saturates or a window
is small. An earlier version recorded only `planted` and would have had you debugging a
correct agent against a wrong answer key.

| Incident | Window | Alert? | Measured |
|---|---|---|---|
| `olark_conversion_collapse` | 2026-06-08 → 06-28 | yes | vol 0.94× (flat), conv **0.27×** |
| `landing_page_outage` | 2026-02-09 → 02-16 | yes | vol **0.40×** |
| `reference_surge` | 2025-11-10 → 12-05 | yes | vol **1.86×** |
| `seo_content_revamp` | 2026-07-20 → 08-05 | yes | conv **1.59×** (a *lift*) |
| `festive_lull` | 2025-10-18 → 10-27 | **no** | vol 0.46× — benign seasonal |
| `google_spend_waste` | 2026-04-06 → 04-24 | yes | spend 2.5×, CAC ₹656 → **₹1,811** |

`festive_lull` is the false-positive test. A detector that flags all six is one nobody
keeps enabled.

### Regenerating
`END` = today, `START` = 14 months back, incidents defined as **days-ago offsets** so
they can never drift outside the window. `SEED = 7`, chosen from a 12-seed sweep as the
draw closest to spec (documented in the config cell; the manifest records measured
effects regardless, so nothing is fudged by this).

Re-import at any time — the importer drops collections first, so it is idempotent:

```bash
node scripts/import_data.mjs ./data/foundry "mongodb://localhost:27017/" leadpulse
```

---

## 4. Phase 1 — what to build next

### 4a. The semantic layer (the core engineering opinion)

**Do not let the LLM write MongoDB aggregation pipelines.** Defend this hard:

- **Safety** — generated pipelines can reach `$where`, `$function`, `$lookup` into
  anything. You cannot reliably sanitise generated code.
- **Cost** — an unindexed `$group` is fine at 9k docs and catastrophic at 9M. The model
  has no idea what is indexed.
- **Testability** — you cannot regression-test free-form code. You can exact-match a
  typed intent object.

The LLM emits a **typed `QueryIntent`**, Zod-validated:

```ts
{ metric: "conversion_rate",
  grain: "day" | "week" | "month" | "quarter",
  dateRange: { from: "2026-08-01", to: "2026-09-24" },
  dimensions: ["lead_source"],
  filters: [{ field: "profile.occupation", op: "eq", value: "Working Professional" }],
  compareTo: "previous_period" | "same_period_last_year" | null,
  limit: 10 }
```

A **deterministic TypeScript compiler** — no AI — turns that into `$match → $group →
$sort`. Metrics are defined once as code: `leads_created`, `conversion_rate`, `cpl`,
`cac`, `avg_days_to_convert`, `sla_breach_rate`, `open_pipeline`, `touches_to_convert`.

This is how Cube.dev and Looker work. It is the right shape here.

### 4b. Two LLM calls, cleanly separated
1. NL → `QueryIntent` (structured output)
2. computed numbers → narrative + chart-type choice

**The arithmetic never touches the model.** That is how you structurally prevent
hallucinated figures, rather than prompting against them.

### 4c. Charts
The tool returns a **typed chart spec**, never an image or raw HTML:

```ts
{ type: "line"|"bar"|"funnel"|"heatmap"|"cohort",
  x: "week", series: ["lead_source"], y: "conversion_rate",
  annotations: [{ at: "2026-06-08", note: "Olark drop begins" }] }
```

React renders it. Every answer returns **narrative + table + chart + the intent JSON**
that produced it — that last part is the audit trail and the trust story.

### 4d. Evals (different axis from the counselor demo)
That demo tested tone, personas, guardrails. Analytics needs:
- **Intent accuracy** — 60–80 golden questions → expected `QueryIntent`, exact-match on
  the compiled pipeline
- **Numeric fidelity** — regex the digits out of the narrative, assert they equal the
  computed values
- **Refusal correctness** — *"what's our LTV?"* has no answer in this data. Saying so is
  a feature, not a failure. Many columns are 25–50% null.

---

## 5. Known traps

### The data path problem — settle this first
The previous project (`D:\Projects\cloudflare-agents-demo`) **never ran the MongoDB
driver inside the Worker.** `src/db/mongo.ts` uses the Atlas Data API over `fetch`, a
`LOCAL_BRIDGE_URL`, and an in-memory fallback store. The Atlas Data API has since been
**sunset**, so that path is gone.

Workers do not support the official driver's TCP/TLS stack the way Node does.
`nodejs_compat` plus `cloudflare:sockets` may work against Atlas — **this is unverified
and is the single biggest technical risk in Phase 1.**

Options:
1. **HTTP bridge** (default in `wrangler.jsonc`, `DATA_PATH_MODE: "bridge"`) — a small
   Node service holds the `MongoClient` and exposes compiled aggregations. Proven
   approach, and the semantic layer makes it clean: the bridge accepts a validated
   `QueryIntent`, not arbitrary pipelines. Needs hosting in production.
2. **Driver in Worker** (`DATA_PATH_MODE: "driver"`) — spike this early against Atlas.
   If it works, delete the bridge.
3. Atlas Data API — **gone**, do not plan around it.
4. Hyperdrive — Postgres/MySQL only, not MongoDB.

**Recommendation:** timebox a spike on option 2 in the first hour. Fall back to 1.

> **Settled.** Option 2 works. The driver runs inside the Worker under
> `nodejs_compat`, verified against local Mongo 8.3 and now exercised by the
> integration suite. `DATA_PATH_MODE` defaults to `"driver"` and the bridge was
> never built. The one rule that makes it work is in `src/db/driver.ts`: the
> `MongoClient` must be owned by a Durable Object, because workerd cancels a
> request that touches I/O created by a different request. A module-level client
> shared across fetch handlers fails with "code had hung". **Still unverified
> against Atlas** — that is the remaining risk, and it is a deployment risk, not
> a design one.

### Deployment needs Atlas
A deployed Worker cannot reach `localhost:27017`. Local is fine for building; set up a
free M0 cluster before deploying (dataset is ~24 MB). Switching is one connection
string plus a re-import.

### Extended JSON on import
`JSON.parse` leaves `{"$date": "..."}` as a plain sub-document — dates import as
objects, every `$dateTrunc` silently returns nothing, and it looks like your query logic
is broken. `scripts/import_data.mjs` uses `EJSON.parse` and verifies the BSON type
afterwards rather than assuming. Keep that check.

### Dependency drift from the previous demo
`npm install` resolved newer majors than the counselor demo used — notably
**mongodb `^7.6.0`** (demo: `^6.14.0`) and **typescript `^7.0.2`**. Expect some API
differences; do not copy `src/db/mongo.ts` across verbatim.

---

## 6. Open decision — needed before writing intent-generation code

**Workers AI (`env.AI`) or Claude via API?**

- Workers AI — zero config, no key, no egress cost; weaker at strict JSON adherence.
- Claude — materially better at structured output, which is *the* job here; needs
  `ANTHROPIC_API_KEY`.

**Recommendation: Claude**, with Workers AI kept as a documented fallback. Both bindings
are already wired in `wrangler.jsonc` via `LLM_PROVIDER`, so this is a one-line switch —
but pick before building, because retry/repair logic differs between them.

> **Settled: Claude** (`claude-opus-5`), with Workers AI as an automatic
> fallback when no key is present — a fresh checkout still runs. The repair
> logic does differ, and both paths are implemented:
> `src/llm/claude.ts` uses two strict tools (`run_query` / `decline`) and feeds
> a rejected object back as an error `tool_result`; `src/llm/workersai.ts`
> flattens the same union into one object with an `action` discriminator,
> because smaller models handle a discriminator better than a tool union.
> `ANTHROPIC_API_KEY` is currently commented out in `.dev.vars`, so the running
> default is Workers AI. Uncomment it to get the intended path.

---

## 7. Project layout

```
D:\Projects\leadpulse
├─ src/
│  ├─ server.ts          Worker entry + AnalystAgent stub (routing proven, logic TODO)
│  ├─ agents/            AnalystAgent, later WatchtowerAgent
│  ├─ semantic/          QueryIntent schema, metric registry, pipeline compiler
│  └─ db/                data-path adapter (bridge | driver)
├─ scripts/import_data.mjs
├─ data/
│  ├─ phase0_lead_data_foundry.ipynb
│  └─ foundry/           *.jsonl + _manifest.json (jsonl gitignored)
├─ wrangler.jsonc        DO + AI bindings, migrations, vars
└─ tsconfig.json
```

Secrets: copy `.dev.vars.example` → `.dev.vars` (gitignored). Never commit
`MONGODB_URI` or `ANTHROPIC_API_KEY`; use `wrangler secret put` for deploys.

---

## 8. First moves in the new session

1. Spike the data path (§5) — timebox it, then commit to bridge or driver.
2. `src/semantic/intent.ts` — Zod `QueryIntent` schema.
3. `src/semantic/metrics.ts` — metric registry.
4. `src/semantic/compile.ts` — intent → aggregation pipeline, pure and unit-tested.
5. Verify against a known truth: Olark weekly conversion must show the June 2026
   collapse (~20% → ~5%, volume flat). If that query is right, the stack is right.
6. Then wire `AnalystAgent`: NL → intent → compile → execute → narrate.

Sanity query that should already work:

```js
db.leads.aggregate([
  { $match: { lead_source: "Olark Chat" } },
  { $group: { _id: { $dateTrunc: { date: "$created_at", unit: "week" } },
              leads: { $sum: 1 }, won: { $sum: { $cond: ["$converted", 1, 0] } } } },
  { $sort: { _id: 1 } }
])
```

---

## 9. Phase 1 — what was actually built

### 9a. Shape

```
src/semantic/     the semantic layer — no AI in this directory at all
  dates.ts        UTC arithmetic, Monday weeks, calendar anchors
  fields.ts       the whitelist: dimensions, filterable fields, value coercion
  metrics.ts      9 metrics, each owning its numerator, denominator and nulls
  intent.ts       Zod QueryIntent + semantic validation + patchIntent
  compile.ts      intent -> aggregation pipeline, pure
  execute.ts      runs it, joins CAC, attaches comparisons, builds rows
  chart.ts        typed ChartSpec, chosen deterministically
src/llm/          the only two places a model acts
  prompts.ts      catalogue generated from the registries, not hand-written
  schema.ts       JSON Schemas generated from the same Zod schemas
  claude.ts       two strict tools + a repair round
  workersai.ts    the no-key fallback
src/agents/
  analyst.ts      AnalystAgent: plan -> compile -> execute -> narrate
src/evals/
  golden.ts       30 golden cases (24 queries, 6 refusals)
```

### 9b. Decisions worth knowing before you change anything

**Metrics bucket by `created_at`, never `converted_at`.** A lead created in June that
converts in August counts in June. That is the only reading under which "conversion by
channel" compares like with like, and it is what makes the Olark collapse land in the
week it happened. Recent buckets are therefore still maturing — the narrator is told to
say so.

**Top-N is two passes.** Ranking a rate needs the computed value, and the computation
lives in `metrics.ts` as TypeScript. Rather than restate every metric as a Mongo
expression — two definitions that will drift — the executor runs a cheap ranking pass
grouped by dimension only, picks winners in TypeScript, then runs the real time-series
query restricted to those members. One definition, bounded cardinality.

**Time-series top-N ranks by volume, not by value.** A three-lead segment sitting at
100% is not the line you want on the chart. `grain: "total"` still ranks by value,
descending, so "best channel" and "worst rep" are both the top row.

**Filter values are always `string[]`.** A union-typed value is the one thing that makes
a strict tool schema unreliable. The compiler coerces against the declared field type in
`fields.ts`, where the type is actually known.

**CAC is two aggregations joined in TypeScript**, not a `$lookup`. Spend lives in
`channel_spend` keyed on `day`; conversions live in `leads` keyed on `created_at`. The
join is on `(period, channel)` with `channel` mapping to `lead_source`.

**Bing spend has no lead-side counterpart.** Phase 0 folded the Bing tail into `Other`
when canonicalising sources, so per-channel CAC for Bing is `null`. The all-paid total
is still correct, because Bing's leads are inside `Other`. Reporting ₹0 there would be
exactly the kind of confidently-wrong number this design exists to prevent.

**Narration failure degrades, it does not 500.** If the second model call fails the
answer still returns with a computed headline and summary, and a note saying so. The
numbers are the product; the prose is decoration.

### 9c. Verification

`npm test` — 96 assertions, 4 files, ~1.5s. The integration suite asserts against
`_manifest.json`'s **`measured`** block, per §3:

- every planted incident reproduces its documented lead count, conversion rate and
  volume-per-day through the full semantic layer
- Google CAC in the spend-waste window computes to **₹1,811**, matching
  `cac_inr.window` to the rupee
- the Olark weekly series shows conversion falling by more than half while volume stays
  within ±30% — the signature of a routing fault rather than a traffic fault
- splitting by a dimension sums back to the undimensioned total
- an empty segment returns `null`, not `0`

It skips itself when Mongo is not running, so a fresh checkout still passes.

### 9d. What is not done

1. **The React UI.** `ChartSpec` is designed and returned; nothing renders it yet.
   `package.json` has `"dev": "vite"` but there is no `vite.config.ts` and no `app/`.
2. **The model half of the eval suite has never run.** `ANTHROPIC_API_KEY` is commented
   out in `.dev.vars`, so the running default is Workers AI. The 30 golden cases are
   structurally validated on every `npm test` (they compile, they sit inside the data
   window, the ids are unique) but no intent has been generated by a model. Run it with
   `RUN_EVALS=1 ANTHROPIC_API_KEY=... npm run eval:intents` — **it costs money**, one
   Opus call per case.
3. **Numeric fidelity is scaffolded, not enforced.** `allowedFigures(result)` in
   `execute.ts` returns every figure the narrator is permitted to state. Nothing yet
   regexes the digits back out of the narrative and asserts membership.
4. **Atlas is unverified.** The driver works on local Mongo under `nodejs_compat`. A
   deployed Worker cannot reach `localhost:27017`, and the Atlas TLS path has not been
   tested. Do this before promising a deploy date.
5. **The golden set is 30 cases, not the 60–80 in §4d.** The shape is right and the
   harness takes more without changes.

### 9e. Try it

```bash
npx wrangler dev
curl -s localhost:8787/api/catalog | head
curl -s -X POST localhost:8787/api/ask -H 'content-type: application/json' \
  -d '{"question":"Show Olark Chat conversion by week in June 2026"}'
```

Every answer carries `intent` and `queries` — the typed intent that was planned and the
exact pipelines that ran. That is the audit trail, and it is the reason to trust the
number above it.

---

## 10. Phase 2 — the Watchtower

### 10a. What it is

A scheduled sweep that finds things without being asked. This is the half that
justifies the Agents SDK: the Analyst is request-in / answer-out and a stateless
Worker would do, while the Watchtower wakes itself, sweeps, remembers what it has
already said, and only speaks when something is new.

```
src/watch/
  stats.ts      exact Poisson and binomial tails, Benjamini-Hochberg — pure
  detect.ts     the three detectors, difference-in-differences — pure
  findings.ts   Finding types, deterministic phrasing, lifecycle merge — pure
  observe.ts    date ranges -> cells, via the Phase 1 semantic layer
  scan.ts       the sweep: windows, FDR, dedup, materiality, ranking
src/agents/watchtower.ts
```

**No AI does any detecting.** The model writes one sentence per *newly raised*
finding — what it probably means and what to check first. If it is unavailable
the alert still arrives with its deterministic headline and impact line.

### 10b. The hard problem, and how it is solved

The foundry plants six incidents. Five should alert. `festive_lull` — a 0.46x
volume drop — must **not**, and it sits right next to `landing_page_outage`, a
0.40x volume drop that must. A naive "this segment is down 40% on its own
baseline" detector cannot tell them apart, because from inside a single segment
they are identical.

**Every detector is a difference-in-differences test.** A segment is measured
against what its own baseline predicts *after* applying the concurrent move in
the rest of the population:

```
expected = segment_baseline_rate x window_length x market_factor
```

During the festive dip every source falls together (0.58, 0.46, 0.54, 0.23,
0.55), the market factor absorbs the fall, and nothing is flagged. During the
landing-page outage one origin falls alone and the divergence *is* the signal.

The whole-population cell has no control by construction, so anything it finds
is reported as a **`market_shift`** — context, never an alert. The rule stands on
its own: nothing you own is channel-agnostic, so a uniform move is demand, not a
fault.

### 10c. Three things that were wrong before they were right

Each was found by measuring, not by reasoning, and each is worth knowing before
touching the detector.

**1. Cohort maturation, per channel.** Conversion lag differs about sixfold by
source — Reference p90 is 9 days, Organic Search 58. A trailing conversion
window is therefore immature *unequally per segment*, which the control arm
cannot absorb. It manufactured conversion findings everywhere. Fixed by giving
the outcome detectors a bounded-horizon metric (`conversion_rate_21d`) and a
window that ends `MATURATION_DAYS` in the past. The cost is stated rather than
hidden: **volume faults surface next morning, conversion and efficiency faults
about three weeks later.** You cannot know a lead failed to convert until it has
had time to.

**2. Simpson's paradox in the control arm.** The control was originally the
pooled complement — all other sources added together. When Reference (92%
conversion) surged, the pooled control *rate* climbed for purely compositional
reasons, every other channel was measured against an inflated expectation, and
the detector reported a Google conversion collapse that never happened, every
day for a fortnight. Fixed with **direct standardisation**: the control's
expectation is rebuilt member by member from each one's own baseline rate applied
to its actual window volume. Measured effect: background finding rate
**0.50 -> 0.17 per scan**, and the phantom fortnight disappeared entirely.

**3. The SLA detector was all noise.** Rep-level breach rate is confounded by
lead mix and load in a way this model does not capture — a rep whose channel mix
shifts shows a real breach-rate move that is not their doing. Every firing in
testing was a false positive and it burned a third of the multiple-comparison
budget. It is not in the sweep. `detectRate` still handles it; re-adding it is
one line in `SPECS`.

### 10d. Other decisions worth knowing

- **Exact tails, not normal approximations.** The cells that matter are the
  small ones, which is exactly where a z-approximation starts inventing
  significance.
- **Benjamini-Hochberg at q=0.05 across the whole sweep.** ~50 tests at an
  uncorrected p<0.05 is two or three false alerts every scan. Window lengths are
  deduplicated *after* the correction — picking the best window first and testing
  afterwards is the classic way to manufacture significance.
- **Significance is necessary, not sufficient.** A finding must also clear a
  materiality floor: 20% off expectation *and* 15 leads / 8 conversions. Nobody
  wants to be woken for a precisely-measured 3% shift.
- **Ranked by business impact, never by p-value**, and attention state is a hard
  sort tier — once someone acknowledges a finding it drops below live ones
  regardless of size.
- **Lifecycle, not repetition.** new -> ongoing -> resolved, keyed on
  `detector:dimension:member`. Re-raising the same alert every scan is the other
  way a detector gets muted, so an ongoing finding is not re-narrated either.
- **Reads to yesterday, never today.** A half-day of leads reads as a
  catastrophic volume drop every single morning.
- **Daily cron (`0 7 * * *`, `WATCH_CRON`).** The windows are measured in days;
  hourly scans would re-test the same data and spend the correction budget for
  nothing.

### 10e. Results

`npm test` — 168 assertions across 8 files.

| Incident | Detected | When | Signal |
|---|---|---|---|
| `landing_page_outage` | yes | next morning | volume 0.61x, p=6e-9, top of feed |
| `reference_surge` | yes | next morning | volume 1.83x, p=1e-5 |
| `olark_conversion_collapse` | yes | +22 days | conversion 0.43x, p=2e-4, **no** volume finding |
| `google_spend_waste` | yes | +22 days | efficiency 0.43x, p=4e-16, CAC ~3x, top of feed |
| `seo_content_revamp` | **no** | — | below detection power — see below |
| `festive_lull` | **correctly silent** | — | reported as `market_shift` only |

**Background rate**, measured over 48 consecutive daily scans from 2025-12-23 to
2026-02-08 (the only stretch where no planted incident falls inside any window a
scan can see): **0.17 findings per scan, 42 of 48 scans completely silent, never
more than 2 at once.**

**The documented miss.** `seo_content_revamp` is a 1.59x conversion lift on
Organic Search, which runs about three leads a day — roughly nine extra
conversions over 17 days. The best two-sided p-value across every window length
and every maturation horizon tested (including an unbounded horizon and a
hand-aligned window) was **0.064**. Under false-discovery control across ~50
cells it cannot clear the bar, and an operating point that admitted it would also
raise several findings a week on quiet data. This is pinned by a test that fails
if sensitivity ever changes, so it surfaces as a decision rather than a surprise.

One honest caveat on the true positives: when a dominant segment moves, its
neighbours move with it in the feed. During the landing-page outage, `API` reads
as a 1.63x surge — partly a real mix shift as leads reroute, partly the control
arm being dragged by the segment under test. Impact ranking puts the causal
finding first, but the co-firings are there.

### 10f. Try it

```bash
npx wrangler dev
```

```bash
curl -s localhost:8787/api/watch
```

```bash
curl -s -X POST localhost:8787/api/watch/scan -H 'content-type: application/json' -d '{"asOf":"2026-05-16T07:00:00Z"}'
```

```bash
curl -s -X POST localhost:8787/api/watch/acknowledge -H 'content-type: application/json' -d '{"key":"efficiency:channel:Google"}'
```

`asOf` is for replaying history; the scheduled sweep uses the current time.

### 10g. What is not done

1. **Nothing delivers the alerts.** They sit in agent state behind `/api/watch`.
   Email, Slack or a push is a `ReportAgent` job (Phase 3).
2. **Baselines are not incident-aware.** A trailing baseline can contain an
   earlier incident, which biases the expectation. Excluding known windows would
   help and is not done.
3. **No seasonality model.** Weekly seasonality is partly absorbed because
   windows are multiples of seven days, but an annual model would need more than
   14 months of data. A holiday calendar would let a `market_shift` be *named*
   rather than merely classified.
4. **`stage`, `owner_id` and geography are not swept.** Only `lead_source`,
   `lead_origin` and paid `channel`.
5. **The narration path has only ever run on Workers AI**, like the rest of the
   project — `ANTHROPIC_API_KEY` is still commented out in `.dev.vars`.
