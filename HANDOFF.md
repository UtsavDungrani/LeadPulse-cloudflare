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
| 3 | `ReportAgent` (cron digests), `LeadDeskAgent` (writes, HITL) | **DONE** — see §11 |

All four agents are complete and tested end to end against the local database,
and there is now a React UI over all of them (§12) with saved conversations, a
navbar and fifteen chart forms behind one rule set (§13), and an overview answer
for the question that names no metric (§14). Every read-out on screen is written
by the model, and every figure in it is checked against the data before it is
shown (§15) — `npm run dev`, then http://localhost:5173.

The largest remaining gaps: **nothing is deployed** (a real URL needs Atlas, §12e),
there is **no authenticated actor** — which now covers both the write path (§11g)
and the conversation list (§13e) — and the model path has only ever run on Workers
AI because `ANTHROPIC_API_KEY` is commented out in `.dev.vars`. Details in §9d,
§10g, §11g, §12e and §13e.

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

> Superseded by §9a, §10a, §11 and §12. Kept for the Phase-0 context.

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

---

## 11. Phase 3 — the digest and the desk

Two agents. One delivers, one writes.

```
src/report/
  digest.ts     deterministic assembly, two windows, markdown rendering
  deliver.ts    sinks: none (default) | webhook
src/desk/
  actions.ts    Zod ActionIntent + the writable-field whitelist — pure
  compile.ts    ActionIntent -> filter + $set, with invariant guards — pure
  apply.ts      preview / apply / undo / audit
src/agents/report.ts
src/agents/leaddesk.ts
src/db/readonly.ts    read-only DataSource wrappers
```

### 11a. The write surface is one method

`DataSource` gained exactly two writes: `updateMany` and `insertOne`. There is
no `deleteMany`, no `drop`, no `runCommand` and no raw handle, because an
interface cannot be talked into an operation it does not expose — and the caller
is ultimately a language model's proposal.

**The Analyst, the Watchtower and the Report agent are handed a source whose
writes throw** (`db/readonly.ts`). `LeadDeskAgent` is the only one with a
writable source. If you are auditing whether a model can change your data, that
agent and `src/desk/` are the entire surface.

### 11b. What may be written, and the rule that decides it

Phase 0's rule was *outcomes are never invented; only timing is synthesised*.
The same rule, carried into the write path:

> The desk can change **how you work a lead**. It can never change **what
> happened to it**.

Writable: `owner_id`, `stage`, `consent.do_not_email`, `consent.do_not_call`.
Not writable, and unreachable rather than merely discouraged — the action enum
*is* the whitelist: `converted`, `converted_at`, `days_to_convert`,
`created_at`, `lead_source`, and everything under `analysis_only`.

Two consequences worth stating:

- **`Won` is not an assignable stage.** It is an outcome wearing a workflow
  field's clothing. A copilot that can quietly mark a lead converted can corrupt
  every number the other three agents report.
- **A stage change never touches a converted lead**, and always writes `is_open`
  alongside `stage`. Those two fields are one fact; writing one without the
  other makes `open_pipeline` disagree with `stage` and nothing downstream would
  notice until someone questioned a report.

`filters` and `dateRange` are both **required**. Combined, they make "change
every lead in the database" unexpressible rather than merely discouraged.

### 11c. The human-in-the-loop path

```
propose  ->  typed ActionIntent, compiled to an exact filter and $set, run as a
             dry run, returned with the real affected count, a sample, and the
             current distribution of the field being overwritten. No write.
approve  ->  count re-checked, prior values captured, update applied, audit
             record appended.
```

There is deliberately **no endpoint that takes a request and writes in one
step**, no auto-approve and no confidence threshold that skips the human.

The guards, in the order they will save you:

- **The preview shows the query, not a description of it.** What you approve is
  `compileAction`'s literal output.
- **The count is re-checked at approval.** If the number of matching leads moved
  between preview and approval, the world changed underneath the proposal and it
  is refused. Verified against a concurrent insert.
- **Proposals are single-use and expire after 15 minutes.** An approval is for
  one change at one moment, not a standing permission.
- **Prior values are captured before the write**, so anything can be undone.
- **The audit collection is append-only.** "Already undone" is derived from the
  presence of a reversal record, not from a mutable flag — a trail you may edit
  is not a trail.
- **Blocked outright**: nothing matches, more matched than the proposal's own
  limit, more than the hard ceiling of 500, or every match already holds the
  target value.

### 11d. The digest reports two windows, on purpose

A digest that reports "conversion rate last week" is confidently wrong.
Conversion lag runs from days to two months depending on channel, so last week's
cohort has barely started converting — the number always looks like a collapse
and always recovers, and the reader learns to ignore it.

So the digest separates what is knowable *now* from what is knowable *yet*:

- **This period** — leads created, cost per lead, SLA breach rate.
- **Matured cohort** — 21-day conversion rate, CAC, days to convert, for a
  window that ended `MATURATION_DAYS` ago.

Both blocks name their window. The change column is phrased by whether the move
is *good* rather than which way it went, so a reader does not have to hold the
polarity of every metric in their head: `up 9% — worse`.

Findings come from the Watchtower rather than a second detector — two components
independently computing "what is wrong" is how a digest ends up contradicting an
alert someone already acted on. The digest states when the Watchtower last
swept, because findings from three weeks ago are not this week's news.

### 11e. Delivery is off by default

`REPORT_SINK` defaults to `none`. The webhook sink additionally needs a
`REPORT_WEBHOOK_URL` secret and rejects anything that is not https.

`none` is not a stub — it is the correct production setting until someone has
decided who should receive these and agreed that lead volumes, rep names and
spend figures may leave the system. Nothing is posted anywhere because a digest
happened to be generated.

### 11f. Results

`npm test` — 217 assertions across 11 files.

The desk's integration tests run in **their own scratch database**, seeded and
dropped by the test file. The `leadpulse` dataset is the answer key for every
other eval in the project, and a write test that mutated the fixture it is
measured against would silently invalidate its neighbours.

Verified end to end through `wrangler dev` against the real data, then reverted:

| Step | Result |
|---|---|
| propose | model produced a valid `ActionIntent`; preview matched 45 leads |
| preview | surfaced that **6 of the 45 were already on REP007** |
| approve | `matched: 45, modified: 39` — the 6 were untouched, as previewed |
| replay the approval | refused: *"already applied"* |
| revert | owner distribution returned **byte-identical to baseline** |
| full suite after | 217 passing — the dataset is intact |

The two audit records from that run are still in the `audit` collection. They
are the honest history of a change that was made and reversed, which is what the
collection is for.

### 11g. What is not done

1. **Still no UI.** Four agents, a chart-spec contract and a markdown digest, and
   nothing renders any of it.
2. **No authentication or actor identity.** `approve` trusts whoever can reach
   the endpoint, and the audit record has no `who`. Before this is exposed to
   anyone, approval needs an authenticated actor and that actor needs to be in
   the audit record — the trail currently answers *what* and *why* but not *who*.
3. **Delivery has never actually posted anywhere**, by design. The webhook path
   is implemented and unit-tested for its refusals; it has not been exercised
   against a live endpoint.
4. **Undo is capped at the proposal's `limit`.** An action that touched the
   maximum 500 leads captures 500 prior values; the cap and the capture are the
   same number, so this holds, but it is a coupling worth knowing about.
5. **No scheduled digest has fired on its own cron** — every run in testing was
   triggered manually with an explicit `asOf`.
6. **The model path remains Workers AI only.** `ANTHROPIC_API_KEY` is still
   commented out in `.dev.vars`. The fallback model produced a valid, correct
   `ActionIntent` for the desk, but its digest summary was degenerate enough
   that a quality gate now rejects a summary citing no figures at all and keeps
   the computed one.

---

## 12. The UI

```
index.html
vite.config.ts
scripts/dev.mjs            starts the Worker and Vite together
src/client/
  main.tsx  App.tsx        shell, tabs, theme toggle
  api.ts                   typed against the server modules, not restated
  charts.tsx               the ChartSpec renderer
  styles.css               tokens; the validated data-viz palette
  components/bits.tsx      card, table, stat tile, disclosure
  views/Ask.tsx  Watch.tsx  DigestView.tsx  Desk.tsx
```

`npm run dev` → **http://localhost:5173**. Four tabs, one per agent.

### 12a. Two processes in dev, one origin in production

The obvious setup — `@cloudflare/vite-plugin`, one process — **does not work here**.
The plugin inspects the Worker's module graph in a runner with no `require`, and
the MongoDB driver's CJS dependencies (`punycode/` via `whatwg-url`) break it.

So dev runs `wrangler dev` on 8787 and Vite on 5173, with Vite proxying `/api`.
That costs one extra process and buys something better: the browser talks to
exactly the Worker every integration test has been run against, not a second
build of it. `scripts/dev.mjs` starts both and tints their output.

In production there is no proxy. `npm run deploy` builds `dist/` and Wrangler
serves it as static assets from the same Worker — verified: `/` returns the app,
`/api/catalog` returns JSON, one origin, no CORS.

### 12b. Charts

`ChartSpec` was designed in Phase 1 as a typed contract so React could render
it. `src/client/charts.tsx` is the only thing that decides *how* — no chart
library, because the spec is narrow and hand-drawn SVG keeps the mark specs
(2px lines, ≤24px bars, a 2px surface gap between stacked segments, a 2px
surface ring on markers) instead of fighting a library's defaults.

The palette is the validated data-viz default, run through the validator in both
modes before a line was written:

```
light  CVD ΔE 9.1 · normal-vision ΔE 19.6 · 3 slots below 3:1 → relief required
dark   CVD ΔE 8.4 · normal-vision ΔE 19.3 · all 8 clear 3:1
```

Rules enforced in the renderer rather than left to callers:

- **Colour follows identity, never rank.** Series take slots in fixed order; a
  filter that drops a series never repaints the survivors.
- **Nothing past eight.** The tail folds into one grey "Other" — a ninth
  generated hue is indistinguishable from an existing slot under CVD.
- **One axis.** There is no code path that draws a second y-scale.
- **The table always ships with the chart.** Three light-mode slots sit below
  3:1 against the surface, and the relief rule for that is visible labels or a
  table view — so it is never behind a toggle.
- **Named categories run horizontally.** A vertical column chart has to thin or
  rotate its labels past a handful of categories, and a category you cannot read
  is a bar that means nothing. First build did exactly that — ten channels, five
  labels — and it was wrong.
- Dark mode is its own set of steps for the dark surface, not an inverted light
  palette.

### 12c. The audit trail is in the interface

Every answer carries "How this was computed": the `QueryIntent` the model
produced and every pipeline the compiler emitted from it, with per-stage
timings. The desk shows the exact filter and `$set` you are approving, not a
paraphrase. That is the difference between a number you are told and a number
you can check.

### 12d. Verified in a browser

| View | What was exercised |
|---|---|
| Ask | Olark weekly — 22.2% → 4.5% → 5.3% → 9.7%, line chart, table, audit trail |
| Ask | Conversion by channel — horizontal bars, all 10 channels labelled, top-10 note |
| Watch | Swept in 117 ms; no incidents; the market shift shown separately with its reason |
| Digest | Both windows, stat tiles with polarity-aware deltas, channel bars, findings |
| Desk | *"Mark every converted lead as Won"* → **declined**, with the reason |
| Desk | Reassignment → preview card: 45 affected, 6 already correct, exact filter and `$set` |

Also checked: light and dark, 430px wide, no horizontal overflow, production
build (77 KB gzipped) served single-origin.

Two bugs the browser found and the tests could not: the tab hash was
write-only, so the back button and a pasted `#watch` link did nothing; and the
chart SVG used `preserveAspectRatio="none"`, which stretched axis text whenever
the container was not exactly 900px.

### 12e. What is still not done

1. **Nothing is deployed.** A real URL needs Atlas — a deployed Worker cannot
   reach `localhost:27017`. That is one connection string plus a re-import.
2. **No authentication.** Anyone who can reach the page can approve a write.
   This is the gap that matters most now; see §11g.
3. **No tests on the client.** The views have been exercised in a browser, not
   asserted in CI. The chart renderer in particular is pure and eminently
   testable.
4. **Hash routing, not paths.** `/#watch` is shareable; `/watch` 404s.
5. **The digest markdown is unused by the UI** — the view renders the structured
   digest instead. `/api/report/latest.md` still returns it for a webhook.
6. **Still Workers AI only.** The digest summary was rejected by the quality
   gate again during this run and fell back to the computed paragraph.

---

## 13. Conversations, a navbar, and the rest of the chart forms

Three changes, one theme: the answer was already right, and none of it was
reachable. A conversation could not be returned to, the views were buttons
pretending to be a nav, and every question came back in whichever single form
`suggestChart` had decided on.

### 13a. The chart rules are now one function

`compatibleCharts(spec, points)` returns every form a result can carry without
lying about itself, and **three callers share it**: `suggestChart` picks a
default out of that list, the narrator may swap to any other member of it, and
the picker above each chart offers exactly it. A form that is wrong for the data
is therefore unreachable from all three directions, and a form that is right is
reachable from all three.

The union went from six forms to fifteen:

```
line  area  stacked_area  column  bar  grouped_bar  stacked_bar
pie  donut  treemap  funnel  timeline  heatmap  scatter  table
```

The exclusions are correctness, not taste, and each one is a real failure mode:

| Rule | Why |
|---|---|
| No stacked rate or average | The stack total is a number that does not exist |
| Unstacked area is single-series | Two translucent fills make a third colour that is in neither palette |
| Part-to-whole needs at least two parts | One slice is a circle |
| Part-to-whole needs a non-negative additive measure | A whole that can contain negative parts is not a whole |
| Grouped bars cap at 4 series × 10 periods | Past that the bars are thinner than the gaps between them |
| Scatter needs a comparison window | There is nothing to put on the second axis otherwise |

**Being hard to read is not on that list.** The first cut of this refused a
pie past eight categories - and then drew twelve-category treemaps and legends
by folding the tail into one grey `Other (n)`. The cap was checking a problem
the renderer had already solved, so ten lead sources produced no pie at all.
Folding is a palette constraint, so it now applies to exactly the forms where
colour carries identity: pie, donut and treemap fold at eight, and ranked bars,
which are one colour and use position instead, show every row.

The same cut offered part-to-whole *only* on categorical results. But over a
time axis the whole is the window and the parts are the series, which is a
different question from the one the line chart answers, not a worse version of
it - so pie, donut, treemap and ranked bars are now offered there too, provided
the measure totals. A rate still gets none of them, because adding conversion
rates together produces a number that was never true of anything. Anything that
collapses the time axis says so under the chart: *totalled across all 9
periods, not one of them*.

Every form that is **not** offered is now listed under the picker with the
reason, from `excludedCharts` - which lives beside the rule that excluded it, so
the two cannot drift. Some reasons are actionable: *scatter needs a comparison
window - try asking for this month against last month*. A form that is absent
with no explanation reads as a form that is broken.

`chart.test.ts` pins the property the whole arrangement rests on: across nine
result shapes this dataset actually produces, **whatever `suggestChart` returns
is something `compatibleCharts` also allows**. If those two ever drift, the
picker silently refuses to show the form the answer arrived in.

The defaults were also spread out, because "every answer is a bar chart" was a
fair complaint: a count over time is a **column** (it happened *inside* a
bucket), a rate over time is a **line** (it is a level that carries between
buckets), and a part-to-whole with two to five slices is a **donut**. The test
asserts at least four distinct defaults across those nine shapes so this cannot
quietly collapse back.

New forms worth a note:

- **Timeline** — one lane per series, one bubble per period, radius on the
  square root of the value, because area is what the eye compares. It answers
  *when* at a glance where a line chart with ten overlapping series cannot.
- **Treemap** — squarified layout (rows grow while the worst aspect ratio in the
  row keeps improving). This is the part-to-whole form that still reads at
  twenty cells, which is exactly where the pie has given up.
- **Scatter** — prior window against this one, with the diagonal as "no change".
  It does in one glance the arithmetic a two-column table makes you do in your
  head.
- **Pie/donut** — labels sit *outside* the ring in text tokens on a leader line.
  A number printed on its own wedge is unreadable on at least two of the eight
  palette slots.

One rule holds all four aggregating forms together: `sliceKey` decides what a
point is called once its own axis is gone - every dimension it carries, or the
period when it carries none. Getting that wrong silently merges rows that are
not the same row, which is a wrong chart that looks fine. The first version
keyed ranked bars on a single dimension and drew the same channel once per
month, calling each one a category.

**The allowed list is derived in the browser, never read off the answer.** Which
forms a result can carry is a fact about the data, not about the moment it was
narrated. The first version shipped the list inside the stored answer, and a
conversation from an hour earlier went on refusing a pie chart that had since
become perfectly legal. Now the same pure function runs on the same points on
both sides, and every stored transcript picks up every later fix to the rules.

Colour identity survives a form change: `toSlices` prepares pie, donut and
treemap identically, so flipping between them never moves a category to another
hue. The folded tail is now labelled `Other (3)` rather than `Other`, because
this dataset has a lead source genuinely called Other and two different things
called the same thing in one legend is a wrong chart.

### 13b. Conversations

Durable Objects cannot be enumerated — you address one by name, but the
namespace will not tell you which names exist. So there is one more Durable
Object, `SessionsAgent`, holding an index of id, title and two timestamps, while
each transcript stays inside its own `AnalystAgent`. The index is a pointer,
never a second copy, so it cannot disagree with what it points at.

`AnalystState` now keeps the **whole answer** per turn, not a summary of it.
Reopening a conversation has to redraw the chart, the table and the pipelines;
keeping only the prose would mean re-running the query — charging for the same
answer twice, against data that may have moved.

Three decisions worth writing down:

- **The Worker updates the index, not the Analyst.** The same response decides
  whether a turn happened and whether the list counts one, so they cannot
  disagree. An `error` is not a turn; a **refusal is**, because a conversation
  where a question was asked and nothing came back is a lie about what happened.
- **A new conversation exists in the browser before it exists on the server.**
  It is registered when its first question lands, which keeps the list free of
  empty conversations nobody asked anything in. The Ask view does not even fetch
  history for an id the index has not heard of.
- **Newest answer first.** One answer is a chart, a table and an audit trail —
  several screens of it — so appending downwards would put every new answer
  below a fold the reader has to scroll past.

Deleting drops the pointer *and* resets the transcript behind it, in that order,
and the button asks once first.

### 13c. The navbar

Links, not buttons. Each view already had an address; a button that mutates
state cannot be opened in a new tab, bookmarked, or reached with the back
button, and there was no reason to keep pretending. The bar spans the window,
stays put while the page scrolls, and marks the current view on the bar itself.

Below about 1000px the panel costs more width than it is worth, so it slides
over the page from a toggle in the bar, behind a scrim.

### 13d. Verified in a browser

| What | Result |
|---|---|
| Picker, counts by month by source | Line · Timeline · Stacked bars · Stacked area · Heatmap · Table — no pie (10 series), no grouped bars (>4) |
| Stacked area, stacked bars, timeline | All three drawn from the same scale; 2px surface gaps between segments |
| Donut | Hole carries the total (6,240), leader-line labels at 52% / 40% / 7% |
| Treemap | Proportional cells, labels on surface plates |
| Scatter | Diagonal "no change", blue above it, orange below |
| Pie over a time series | Seven sources plus `Other (3)`, captioned *totalled across all 9 periods* while the table keeps all ten rows |
| "Why not the other 9 forms?" | Each absence explained under the picker |
| Conversations | Asked twice, started a new one, reopened the first — both answers redrawn from the Durable Object, original 7,048 ms timing intact |
| Navbar | Active view underlined, hash links, back button |
| Dark mode | Navbar, panel, scrim and cards all stepped for the dark surface |
| Production | `/`, `/assets/*.js`, `/api/sessions`, `/api/catalog` all 200 from one origin |

Tests: **12 files, 241 passed**. Build: 12.0 kB CSS (3.2 gzip), 262 kB JS
(80.8 gzip).

Three bugs the browser found that the tests could not: the timeline's first
bubble overlapped its own lane label, because the lane started at a fixed offset
rather than one clearing the largest radius the chart can draw; a CSS escape in
the disclosure marker came through as a control character; and the two rule
defects above, which only showed up as *"where is the pie chart?"* in front of a
real question with ten lead sources in it.

### 13e. What is still not done

Everything in §12e still stands — **nothing is deployed** and **there is still
no authentication**, which remains the gap that matters most. Added to it:

1. **Conversations are global.** With no authentication, every visitor sees
   every conversation. Today that is one person's dataset on one laptop; the
   moment this has a URL, the session list is the second thing that needs an
   authenticated actor, right behind the write path.
2. **The renderer is still untested.** `chart.test.ts` covers the *rules* -
   which are pure and now well pinned - but not the SVG. The layout functions
   (`squarify`, `timeScale`, `toSlices`) are pure and are the obvious next ones.
3. **Twenty turns per conversation, fifty conversations.** Both are memory
   bounds rather than preferences, and neither is enforced by anything except a
   `slice`.
4. **The picker resets to the default when a conversation is reopened.** The
   chosen form is view state, not part of the answer, so it is not persisted.
5. **The narrator is constrained by the rules as they stood when it ran.** Only
   the *picker* recomputes; a stored answer's default chart type is whatever was
   chosen at the time. That is the right way round - the narration text refers
   to the chart it saw - but it does mean a default can look conservative next
   to a picker that has since grown.

---

## 14. The overview: answering the question that names no metric

Found by asking *"show me yesterday's matrix"*. The refusal that came back was
correct - `matrix` is not a metric, and both metrics it suggested instead were
real ones. But the question next to it was not:

```
"show me yesterday's metrics"  ->  headline: "Yesterday's Lead Creation"
                                   intent:   metric = leads_created
```

You asked for *metrics*, plural, unspecified. It picked one of ten and presented
the answer as though that were the question. No note, no hedge. This system
refuses when it cannot answer - so quietly answering a **narrower** question is
strictly worse than the refusal, and it is the one failure mode a reader cannot
catch, because the answer looks perfect.

### 14a. A third thing a plan can be

`AgentPlan` was `query | refusal`. It is now `query | overview | refusal`, and
`overview` is deliberately the smallest intent in the codebase:

```ts
OverviewIntentSchema = { dateRange, filters }
```

No `metric` - that is the entire point. No `dimensions` - an overview is a
window. And **no `compareTo`**, which was a field until the model set it to
`none` on the first live run and produced a card of seven numbers with no
deltas. "How did yesterday go" is a question about a change; the comparison is
not optional. A field that should always have one value is better removed than
defaulted, so the comparison is now hard-coded and the model cannot decline it.

`suggestChart` has no equivalent here: an overview gets **no chart**. Seven
unrelated measures share no axis, and putting them on one is the dual-axis
mistake with five more axes. It gets stat tiles, and the two blocks are the ones
the weekly digest already uses, for the reason the digest already documents.

### 14b. The maturation split is the whole point

Reporting yesterday's conversion rate is confidently wrong - yesterday's cohort
has barely started converting, so the number always looks like a collapse and
always recovers. `overviewWindows` is the only decision in this feature that can
be wrong in a way a reader would not notice, so it is pure and separately
tested:

| Asked for | Outcome tiles describe |
|---|---|
| yesterday (`2026-09-23`) | `2026-09-03` — same length, lagged past `MATURATION_DAYS` |
| last week | the equivalent week ending `2026-09-03` |
| June 2026 | June 2026 — already mature, nothing is shifted |

The card says which window it used, and why, in both the heading and the note.

### 14c. Every tile is an ordinary query

There is no new query path and no new arithmetic. Each tile builds a normal
`QueryIntent` and runs it through the same compiler, so all sixteen pipelines
appear in the audit trail under "How this was computed".

That reuse also supplies the filter rule for free: `cpl` and `cac` read
`channel_spend` and cannot be filtered by a lead field. Rather than reimplement
that, a metric is in the overview **exactly when `validateIntent` accepts a
query for it**, and anything it rejects is dropped with a note naming it. The
rule cannot drift from the single-metric path because it *is* the single-metric
path.

The summary is computed, not written. Seven numbers and their deltas are
described by arithmetic, and a model asked to describe them reaches for a cause
it cannot see. It is polarity-aware - *up* is not *good* until you know the
metric - and when every move went the same way it says so once at the end
rather than tagging each one.

### 14d. What the first live run broke

The Workers AI planner padded `filters` with an `is_not_null` on **every field
it could name**, including a spend field. Each metric then failed validation
individually and the overview came back with no tiles at all - an empty card
that reads like a working answer.

Three fixes, in order of how much they matter:

1. **`validateOverview` rejects a filter set spanning both collections.** No
   metric reads both, so such a set can only ever report nothing. Rejecting it
   turns a blank card into a repair prompt the planner can act on.
2. **The `filters` field describes itself** - *"almost always empty; never add a
   filter the question did not ask for"* - which reaches the model through the
   generated JSON Schema, not just the system prompt.
3. **A loud note if the live block is ever empty anyway.** It should now be
   unreachable; an empty card that looks like an answer is worth being noisy
   about if it is not.

### 14e. Verified

| Question | Result |
|---|---|
| `show me yesterday's metrics` | Overview, 7 tiles, outcomes lagged to `2026-09-03`, 16 pipelines |
| `how did last week go` | Overview with deltas on every tile |
| `how are we doing this month` | Overview, `2026-09-01` to `2026-09-24` |
| `leads created yesterday` | **Still a single-metric answer** — the "prefer run_query" rule holds |
| `show me yesterday's matrix` | Still refused, correctly |

In the browser: polarity colours right (leads −29% red, cost per lead −12%
green, SLA breach −6% green), both blocks headed with their own window.

Tests: **13 files, 266 passed** — 20 new, covering the window arithmetic, the
block membership, the filter rules and the summary's phrasing.

### 14f. What is still not done

1. **The overview cannot be broken down.** It is one window, no dimensions. "How
   did yesterday go, by channel" is seven charts, and that is a different
   feature.
2. **A follow-up cannot patch it.** `lastIntent` is deliberately left untouched
   by an overview - there is no single metric for "now break that down by city"
   to patch - so a follow-up patches whatever single-metric question came
   before it, not the overview.
3. **The metric list is fixed.** Seven metrics, chosen here rather than by the
   question. `touches_to_convert`, `leads_converted` and the raw
   `conversion_rate` are deliberately absent; the last one because it counts
   conversions whenever they happened, which is a different kind of wrong from
   the one the maturation lag fixes.
4. **The planner's choice between `run_query` and `overview` is untested at the
   model level.** The golden eval cases in `src/evals` have never been run
   against Claude, and this adds a third branch for them to get wrong.

---

## 15. Every read-out is written by the model, and every figure in it is checked

The overview shipped in §14 wrote its own summary from the numbers, and said so
on the card. That was the wrong call: the prose a reader sees should come from
the model. Making that true without letting invented numbers through is the
whole of this section.

### 15a. The guard is what makes the request safe to grant

`src/llm/figures.ts` — `checkFigures(prose, brief)` extracts every number from
both and fails if the prose contains one the brief did not. It normalises
thousands separators and trailing zeros, and ignores units, because it is the
digits that can be invented:

```
brief: "Leads created: 181 (prior window 169, +7%)"
"Leads rose 7% to 181"     ok
"Leads rose to 212"        rejected - 212 was never in the data
"Leads were up 12%"        rejected - the model recomputed and got it wrong
```

It is a containment check, not a proof: a model can still attach a real number
to the wrong label. What it makes impossible is the failure that actually
matters, which is a confident, plausible, entirely invented figure sitting in a
sentence that reads exactly like the true ones around it.

It now runs on **both** narration paths - the single-metric answer and the
overview. A rejection falls back to the computed summary and says so on the
card, naming the figures that caused it. The card always states which it is
getting:

> Written by the model, over figures it was handed and could not recompute.
> Every number in it was checked against the data below.

This is the `allowedFigures` idea the eval suite scaffolded in Phase 1 and never
enforced. It is enforced now, at runtime, on every answer.

### 15b. Getting the fallback model to actually answer

`narrateOverview` was added to the provider interface and both implementations.
On first measurement the free Workers AI model produced a usable read-out
**four times in six** - the rest fell back to the computed summary, which is not
what anyone asked to read. Three fixes, each found by making the failure say
what it was rather than guessing:

1. **One retry** on the prose-only calls. Planning does not get one - a bad
   intent is repaired by feeding the validation error back, which beats a blind
   retry - but a malformed *narration* has nothing to feed back.
2. **Salvage JSON with prose around it.** The model answers a `json_schema`
   request with a fenced block or a sentence of preamble often enough to matter.
   `firstJsonObject` scans for the outermost balanced braces, ignoring anything
   inside a string literal.
3. **Close a string the model forgot to close.** The actual live failure, once
   the error carried the payload: `561 chars, ends: ...converted into
   customers.}` — a complete sentence, a closing brace, and no closing quote
   between them. Closing it guesses at nothing; `JSON.parse` still has to
   accept the result. It **refuses** when the text does not end on sentence
   punctuation, because that means the response was cut off mid-thought, and
   half a sentence presented as a finished read-out is worse than none.

After all three: **eight for eight**. The salvage rules have enough edge cases -
braces inside strings, escaped quotes, genuine truncation - that they are unit
tested directly rather than through a live call, which would test the model
instead of the rule.

### 15c. Two diagnostics that were lying

- **The status endpoint reported the configured provider, not the resolved
  one.** `LLM_PROVIDER` is `claude`, `ANTHROPIC_API_KEY` is commented out, so
  Workers AI is what answers - and `/agents/analyst-agent/default` said
  `llm: "claude"` anyway. It now reports both `llm` (what answered) and
  `llmRequested` (what was asked for).
- **"Narration was unavailable" hid the reason.** A malformed response, a
  refusal and an exhausted quota are different problems wanting different fixes.
  The note now carries the message, which is how 15b's third fix was found at
  all.

### 15d. The free tier is finite

Measuring the pass rate above burned through the Workers AI daily allocation
(10,000 neurons). The binding throws `4006` and tells you to buy a Cloudflare
plan, which is not the cheapest fix available here, so that error is now caught
and re-thrown naming the one this project already has:

> …this is the free fallback model. It resets daily; to carry on now, put
> `ANTHROPIC_API_KEY` in `.dev.vars` and restart. `LLM_PROVIDER` is already
> `"claude"`, so nothing else needs changing.

### 15e. What is still not done

1. **The quality of the prose is the fallback model's.** It passes the figure
   check and still writes flatly, and it reads polarity from the metric
   registry rather than from sense - it called a high count of stale leads
   "good for the business" because `open_pipeline` is registered as
   higher-is-better. Claude was what the prompts were written for.
2. **The figure check cannot catch a real number against the wrong label.**
   That needs the narration to cite which tile each figure came from, which is a
   bigger change to the narration schema.
3. **Computed fallbacks still exist, and should.** A model that fails, refuses
   or invents a figure must not take the answer down with it. The card says
   plainly when it fell back, which is the honest version of granting this
   request rather than the absolute one.
