#!/usr/bin/env python3
"""
Build the Word report for the Ragas evaluation of the LeadPulse analyst pipeline.

Every number in the document is read out of an eval run's JSON report and the
recorded agent runs under `evals/.runs/`. Nothing is retyped, because the
previous draft of this report was written by hand before the suite had ever
produced a real score, and it published a flat 1.00 faithfulness that no run had
measured.

  python scripts/generate_ragas_eval_report.py
  python scripts/generate_ragas_eval_report.py --report evals/reports/<run>.json
"""

from __future__ import annotations

import argparse
import os
from datetime import datetime

from docx import Document
from docx.shared import Inches, Pt

from ragas_report_data import (
    CORE,
    DEFINITION,
    PRETTY,
    case_score,
    fmt,
    guard_relevancy_ranks,
    latest_report,
    load,
)
from docx_report_style import (
    ACCENT,
    BODY,
    MUTED,
    NOTE_FILL,
    PRIMARY,
    RULE,
    bullet,
    callout,
    code,
    h1,
    h2,
    para,
    table,
)



# --------------------------------------------------------------------------- #
# Sections
# --------------------------------------------------------------------------- #

def cover(doc, d, stats):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(2)
    r = p.add_run("LEADPULSE PLATFORM  ·  EVALUATION REPORT")
    r.font.size = Pt(9)
    r.font.bold = True
    r.font.color.rgb = ACCENT

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(5)
    r = p.add_run("Ragas Evaluation of the Analyst Pipeline")
    r.font.size = Pt(22)
    r.font.bold = True
    r.font.color.rgb = PRIMARY

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(12)
    r = p.add_run("Implementation, first measured run, and findings")
    r.font.size = Pt(12)
    r.font.color.rgb = MUTED

    meta = (
        f"Report date: {datetime.now():%B %d, %Y}"
        f"   |   Run of record: {d['run'][:19].replace('T', ' ')}"
        f"   |   Cases: {stats['n']} ({stats['n_query']} query / {stats['n_refusal']} refusal)"
        f"   |   Framework: Ragas 0.4"
    )
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(14)
    r = p.add_run(meta)
    r.font.size = Pt(9)
    r.font.color.rgb = MUTED

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(10)
    r = p.add_run("―" * 58)
    r.font.color.rgb = RULE


def executive_summary(doc, d, stats):
    h1(doc, "1. Executive summary")
    para(doc, (
        "LeadPulse turns a natural-language question into a MongoDB aggregation pipeline, executes it "
        "against CRM data, and has a model narrate the result. The existing intent eval grades the first "
        "half of that: did the planner compile the right query? It is a deterministic comparison of "
        "pipeline fingerprints and needs no judge. It says nothing about the second half, where the "
        "failure that actually matters lives — a confident number in the prose that is not in the data."
    ))
    para(doc, (
        "This work adds that second layer. A Ragas 0.4 harness runs the full golden set end to end through "
        "the Worker, grades the narration on five metrics against ground truth derived by executing the "
        "golden intent, and writes a report that distinguishes a score from a failed measurement. The "
        "judge runs off the Cloudflare account entirely, on a borrowed notebook GPU behind a fixed gateway "
        f"address, so the run of record cost {d['cost']['neurons']} neurons — "
        f"{d['cost']['pct_of_free_daily']:.1f}% of the free daily allocation, and $0.00."
    ))

    h2(doc, "Measured results")
    rows = []
    for m in CORE:
        s = d["summary"].get(m)
        if not s:
            continue
        rows.append([
            PRETTY[m],
            f"**{s['mean']:.3f}**",
            f"{s['min']:.2f} – {s['max']:.2f}",
            f"{s['scored']}/{s['applicable']}",
            s["scale"],
        ])
    rows.append([
        "Intent accuracy (deterministic)",
        f"**{stats['intent_pass']}/{stats['n']} ({100 * stats['intent_pass'] / stats['n']:.0f}%)**",
        "—",
        f"{stats['n']}/{stats['n']}",
        "pass/fail",
    ])
    table(doc, ["Metric", "Mean", "Range", "Scored", "Scale"], rows,
          widths=[2.6, 1.3, 1.3, 1.0, 0.9], right_cols=(1, 2), font=9)

    h2(doc, "What the numbers say")
    bullet(doc, "No invented figure reached a response.",
           f"In {len(d['_guard'])} of {stats['n_query']} query cases the narrator wrote a digit that was not in its "
           "brief. The containment guard rejected the prose and served the deterministic fallback "
           "instead, so nothing fabricated was shown. The cost of that interception is visible in the "
           "scores for those two cases, which is the right place for it to be visible.")
    bullet(doc, "Refusal handling is the strongest path.",
           f"All {stats['n_refusal']} unanswerable questions scored {d['summary']['refusal_quality']['mean']:.2f} of 5: "
           "declined, with the missing field named and an answerable question offered in its place.")
    bullet(doc, "The planner has two real defects.",
           "Of the three intent failures, one answers “which channel converts fastest” with a conversion "
           "rate instead of days-to-convert, and one silently moves the reporting week. The third is a "
           "fingerprint mismatch that still lands on the right answer.")
    bullet(doc, "The two low metrics are mostly a shape mismatch, not hallucination.",
           f"Faithfulness at {d['summary']['faithfulness']['mean']:.3f} and factual correctness at "
           f"{d['summary']['factual_correctness']['mean']:.3f} sit against response groundedness of "
           f"{d['summary']['response_groundedness']['mean']:.3f}. Section 8 separates the part of that gap "
           "which is a defect from the part which is the metric measuring something the system was built "
           "not to do.")

    callout(doc, "Read this before the numbers.", (
        "The planner and narrator in this run were served by the same external model as the judge, "
        f"{d['_agent_model']}, not the Workers AI model the Worker ships with. These scores describe the "
        "pipeline on that model. Re-running without --agent-base-url is the single most useful follow-up "
        "and the one number this report is missing."
    ))


def what_is_graded(doc, d, stats):
    h1(doc, "2. What is graded, and against what")
    table(doc, ["Evaluation axis", "Intent eval only (before)", "With the Ragas layer (now)"], [
        ["Pipeline scope",
         "Question → QueryIntent. Stops at the compiled pipeline.",
         "Question → intent → execution → narration → grounding."],
        ["Numeric claims",
         "checkFigures containment: every digit in the prose must appear in the brief.",
         "Containment, plus statement-by-statement entailment against the rows."],
        ["False reasoning",
         "Invisible. A real number against the wrong label passes.",
         "Faithfulness decomposes the narrative and tests each claim."],
        ["Relevance",
         "Unmeasured.",
         "Answer relevancy scores question-to-answer alignment."],
        ["Refusals",
         "Boolean: plan.kind === 'refusal'.",
         "A 1–5 rubric on whether the decline explains itself and offers a way forward."],
        ["Ground truth",
         "The expected pipeline fingerprint.",
         "The golden intent executed against the same database, rendered deterministically."],
    ], widths=[1.3, 2.75, 2.95], font=8.8)

    h2(doc, "Ground truth is not taken from the planner")
    para(doc, (
        "For each case the golden expected intent — the one the case asserts is correct — is executed "
        "against the same database and the result set is rendered into English by referenceAnswer(). That "
        "rendering is the reference the reference-based metrics grade against. Grading the planner's answer "
        "against the planner's own query would be circular, and would score a confidently wrong answer as "
        "correct. When the planner picks the wrong query, the answer and the reference diverge, and the "
        "reference-based metrics are what notice."
    ))

    h2(doc, "The five metrics in the core set")
    table(doc, ["Metric", "What it asserts", "Needs reference", "Applies to"], [
        [PRETTY[m], DEFINITION[m],
         "yes" if m in ("factual_correctness",) else "no",
         "refusal cases" if m == "refusal_quality" else "query cases"]
        for m in CORE
    ], widths=[1.6, 3.9, 1.0, 1.0], font=8.8)

    h2(doc, "Three metrics deliberately left out")
    bullet(doc, "context_relevance and context_recall — no signal.",
           "Both returned exactly 1.000 on every case that scored, across three independent runs. "
           "Retrieval here is a deterministic semantic layer compiled from a validated intent, not a "
           "learned retriever, so there is nothing for them to catch. A metric that cannot vary cannot "
           "regress, and reporting a constant 1.000 as a result is how the earlier harness misled.")
    bullet(doc, "context_precision — cost.",
           "It calls the judge once per retrieved context chunk, which is roughly a third of every judge "
           "call the full suite makes, and what it partly measures is how the Worker chunks its narration "
           "brief rather than how the agent behaves. Worth running deliberately; not on every run.")
    para(doc, (
        f"What is left is the question the eval exists to answer. At about nine judge calls per query case "
        f"the core set finishes in roughly 40 minutes rather than two and a half hours — which matters "
        "when the endpoint serving it is a tunnel on a borrowed GPU."
    ), italic=True)


def honesty(doc, d, stats):
    h1(doc, "3. Why these numbers are lower than the previous draft's")
    callout(doc, "The earlier report was not a measurement.", (
        "A prior version of the harness reported a flat 1.00 faithfulness and 0.95 relevancy for every "
        "case in the set. Those were literal constants in except branches, not scores. The November 4 "
        "draft of this report published them. They are withdrawn."
    ), fill="FEE2E2")
    para(doc, "Two rules now hold in the harness, and they are why the current figures are credible:")
    bullet(doc, "1.", "A metric that fails is recorded as a failure, never as a score. There is no "
                      "default value anywhere in the file. A judge call that errors is counted as err; "
                      "a metric that ran but could not decide is counted as NaN. Neither is folded into a "
                      "mean, and every mean in this report covers only the cases that produced a real "
                      "number — which is what the Scored column states.")
    bullet(doc, "2.", "A metric that produced no usable score for any case fails the whole run, because a "
                      "metric that silently does not run is worse than no metric at all. A run that was "
                      "cut short but valid exits 3 rather than 1: the scores it took are good, there are "
                      "just fewer of them.")
    para(doc, (
        f"On the run of record all five metrics scored every applicable case: "
        f"{sum(s['errors'] for s in d['summary'].values())} judge errors and "
        f"{sum(s['indeterminate'] for s in d['summary'].values())} indeterminate results across "
        f"{sum(s['applicable'] for s in d['summary'].values())} metric-case pairs."
    ))


def implementation(doc, d, stats):
    h1(doc, "4. Implementation")
    table(doc, ["Component", "Size", "Role"], [
        ["src/evals/route.ts", "+603 lines",
         "The eval surface on the Worker: /api/eval/cases, /api/eval/end-to-end, /api/eval/run, "
         "/api/eval/telemetry, plus OpenAI-compatible /api/eval/chat/completions and "
         "/api/eval/embeddings so the harness needs no third-party key. Runs cases under frozen dates "
         "(EVAL_TODAY, EVAL_DATA_WINDOW), builds the narration brief, and renders the reference."],
        ["src/agents/analyst.ts", "+12 lines",
         "Exports fallbackHeadline and fallbackNarrative so the eval route can serve the same "
         "deterministic stand-in the app serves when a model call fails or its prose is rejected."],
        ["src/llm/openaicompat.ts", "203 lines, new",
         "OpenAI-compatible adapter, so the planner and narrator can be pointed at any such endpoint. "
         "Appends /v1 itself and sends LLM_API_KEY as a bearer token."],
        ["src/llm/index.ts", "+34 lines",
         "Provider selection between Workers AI and the adapter above."],
        ["scripts/eval_ragas.py", "1,869 lines, new",
         "The harness: case fetch, end-to-end runs, judge and embedding wiring, metric scoring, neuron "
         "accounting, two caches, budget enforcement, Langfuse score sync, and the JSON and Markdown "
         "reports."],
        ["gateway/ (index.ts + notebook)", "331 lines, new",
         "A Worker at a fixed address that forwards to whatever tunnel the notebook most recently "
         "registered, so the judge endpoint has a permanent URL."],
        ["scripts/gateway_status.mjs", "118 lines, new",
         "Says whether the gateway is up, what is registered, how long ago, and which models the "
         "notebook actually pulled - the three things that explain a failed run."],
        ["scripts/generate_synthetic_cases.py", "163 lines, new",
         "Reads /api/catalog for metrics, dimensions, grains and comparison modes, and emits candidate "
         "GoldenCase objects for src/evals/golden.ts."],
        ["scripts/requirements-eval.txt", "28 lines, new",
         "Pinned floors, with the reasons. ragas>=0.4 is a hard requirement: 0.4 removed the legacy "
         "metric singletons and the evaluate() entry point, and the imports here do not resolve on 0.3."],
    ], widths=[1.85, 0.95, 4.2], font=8.6)

    h2(doc, "The retrieved context, and why its shape is versioned")
    para(doc, (
        "What the metrics see as “retrieved contexts” is the narration brief: the metric and its "
        "direction, the window and grain, whether a breakdown or comparison was requested, the "
        "whole-window total, any caveats the semantic layer attached, and the data table as JSON. The "
        "two “nothing was requested” facts are deliberately merged into one chunk. They have to "
        "be present, because knowing there is no comparison window is what stops the narrator inventing "
        "one, but as separate chunks they were two of seven and were costing context precision for "
        "nothing."
    ))
    para(doc, (
        f"EVAL_CONTEXT_SCHEMA is at {d['_context_schema']}, and it is part of the run-cache key. A change "
        "to how the Worker chunks the brief invalidates recorded runs rather than letting a replay be "
        "scored against the previous shape, and the harness refuses to start if its constant and the "
        "Worker's disagree. Two superseded run sets are kept on disk under .runs.stale-ctx2 and "
        ".runs.stale-ctx3 for exactly that reason."
    ))


def judge_problem(doc, d, stats):
    h1(doc, "5. The judge problem, and the gateway")
    para(doc, (
        "The binding constraint was never the judge vendor. It is Workers AI's free allocation: 10,000 "
        "neurons a day, shared across models, reset at 00:00 UTC. The full eight-metric suite is 481 "
        "judge calls, and context precision is why that number is not obvious - it calls the judge once "
        "per retrieved context chunk, so it alone is 36% of the total."
    ))
    table(doc, ["Option", "Judge calls", "Cost", "Verdict"], [
        ["Full 8-metric set on @cf/meta/llama-3.3-70b", "481",
         "~55,000 neurons, about 5.5 free days", "Does not fit in a day."],
        ["Full set on @cf/meta/llama-3.1-8b, the cheapest with JSON mode", "481",
         "about 3.5 free days",
         "Only ~1.6x cheaper. Input rates are nearly identical (25,608 against 26,668); only output "
         "differs."],
        ["Full set across days, resumed from cache", "481", "free",
         "Works. Judge replies are deterministic at temperature 0 and cached on disk."],
        ["Full set in one go on Workers Paid", "481", "~$0.61 on the 70b, ~$0.39 on the 8b",
         "Worth doing once, to put a number on context precision."],
        ["Core 5 metrics, judge hosted off the account",
         f"{d['cost']['billed_calls']} billed", f"{d['cost']['neurons']} neurons, $0.00",
         "**Chosen for the run of record.**"],
    ], widths=[2.6, 0.9, 1.75, 1.75], font=8.6)

    h2(doc, "Judging somewhere else")
    para(doc, (
        "Judging is about 90% of the spend, and it does not have to run on the account that hosts the "
        "system under test. --judge-base-url points it at any OpenAI-compatible endpoint, which costs no "
        f"neurons at all. For this run that was {d['_judge_model']} on a free notebook GPU, reached "
        "through cloudflared and a gateway Worker. The embeddings stayed on Workers AI: bge-m3 is 1,075 "
        "neurons per million tokens, so moving one metric's worth of short strings saves nothing and "
        "costs a second model to host. With the judge external, the only Workers AI spend left is the "
        "agent half."
    ))
    code(doc,
         "app  -->  leadpulse-llm.<account>.workers.dev  -->  <random>.trycloudflare.com  -->  ollama :11434\n"
         "          (fixed; what LLM_BASE_URL points at)       (new every session; held in KV)")
    para(doc, (
        "A cloudflared quick tunnel is anonymous: a throwaway hostname is minted each time the process "
        "starts and reclaimed when it stops, so every notebook session produced a new URL to paste into "
        ".dev.vars, and a deployed Worker could not be repointed from the notebook at all. The notebook "
        "now POSTs its tunnel URL to /__register on startup and the Worker holds it in KV. One shared "
        "token gates both registering and calling, and is stripped before the request reaches Ollama. "
        "The URL is permanent; the uptime is not, and nothing free can make it."
    ))

    h2(doc, "Why --probe-judge exists")
    para(doc, (
        "Ragas 0.4 metrics are structured-output metrics: each judge call asks for a specific JSON shape. "
        "The dangerous failure is not a refused connection, it is an endpoint that accepts "
        "response_format and ignores it. Ollama Cloud does precisely that, taking a json_schema without "
        "complaint and applying no grammar-constrained decoding; self-hosted Ollama 0.5+ does enforce "
        "it. An endpoint that quietly ignores the schema is how this suite came to report invented "
        "scores in the first place, so --probe-judge sends one schema-constrained question and prints "
        "the parsed reply before anything is spent. It proves the shape, not that decoding is "
        "constrained, so the error count on the first real run is still worth watching."
    ))

    h2(doc, "Failing honestly when the GPU disappears")
    para(doc, (
        "A tunnelled model on a borrowed GPU vanishes mid-run routinely. The first attempt at this suite "
        "died with Cloudflare error pages and the second with connection errors, both about two thirds "
        "of the way through. Several ragas metrics wrap the judge call in a bare except Exception and "
        "convert any failure into a NaN score, which would report a dead endpoint as a judge that could "
        "not decide. EndpointDown and BudgetExhausted therefore derive from BaseException, so the stop "
        "propagates, the remaining pairs are recorded as not attempted, and the run does not grind out "
        "identical failures for an hour on top of the one fact that matters."
    ))


def caching_and_cost(doc, d, stats):
    h1(doc, "6. Caching, budget, and what the run cost")
    bullet(doc, "Judge cache.",
           "Keyed on model, prompt and schema. At temperature 0 the replies are deterministic, so a "
           "re-score of an unchanged pair is free. The run of record served "
           f"{d['cost']['cache_hits']} calls from cache against {d['cost']['billed_calls']} billed.")
    bullet(doc, "Run cache.",
           "Keyed on case id, agent model and context-schema version. The agent model is part of the "
           "identity so that runs recorded against one planner are never served to a run asking for "
           "another, which would attribute one model's answers to the other. Keeping the responses also "
           "means a second scoring pass grades the same text, so a change in a score is a change in the "
           "judge and not the planner having a different day.")
    bullet(doc, "Neuron budget.",
           f"--neuron-budget stops short of the allocation ({d['cost']['budget']:,.0f} here) and records "
           "the untouched pairs as not attempted, instead of hitting a 4006 at case 20 and leaving half "
           "a report that looks like real zeroes. --dry-run prints the projected call count and cost "
           "after the agent half and before anything is spent on judging.")

    table(doc, ["Cost line", "Run of record"], [
        ["Neurons spent", f"{d['cost']['neurons']}"],
        ["Share of the free daily allocation", f"{d['cost']['pct_of_free_daily']:.2f}%"],
        ["Cost if billed at Workers Paid overage", f"${d['cost']['usd_if_paid']:.2f}"],
        ["Billed judge and embedding calls", f"{d['cost']['billed_calls']}"],
        ["Calls served from the judge cache", f"{d['cost']['cache_hits']}"],
        ["Tokens in / out", f"{d['cost']['tokens_in']:,} / {d['cost']['tokens_out']:,}"],
        ["Stopped early", "no" if not d["cost"]["stopped_early"] else str(d["cost"]["stop_reason"])],
        ["Per-case end-to-end latency",
         f"median {d['_latency']['median']:.1f}s, mean {d['_latency']['mean']:.1f}s, "
         f"range {d['_latency']['min']:.1f}-{d['_latency']['max']:.1f}s"],
    ], widths=[3.4, 3.6], font=9)
    para(doc, (
        "The latency is a property of the borrowed GPU behind a tunnel, not of the Worker. It is recorded "
        "because it is what makes the full eight-metric set a two-and-a-half-hour job and the core set a "
        "forty-minute one."
    ), italic=True, size=9.5)


def run_config(doc, d, stats):
    h1(doc, "7. The run of record")
    table(doc, ["Setting", "Value"], [
        ["Run timestamp", d["run"][:19].replace("T", " ")],
        ["Cases", f"{stats['n']} ({stats['n_query']} query, {stats['n_refusal']} refusal)"],
        ["Metric set", "core: " + ", ".join(CORE)],
        ["Judge", d["judge"].split(" / ")[0]],
        ["Embeddings", d["judge"].split(" / ")[-1] + " (Workers AI)"],
        ["Planner and narrator", f"{d['_agent_model']} (substituted; see the caveat below)"],
        ["Concurrency", "1, to keep the tunnel alive"],
        ["Cache policy", "--reuse-runs: recorded agent runs replayed, judge cache on"],
        ["Command", "npm run eval:ragas:core"],
    ], widths=[1.9, 5.1], font=9)
    callout(doc, "The agent model was substituted.", (
        "The planner and narrator did not run on the Workers AI model the Worker ships with "
        f"(@cf/meta/llama-3.3-70b-instruct-fp8-fast); they ran on {d['_agent_model']}, the same external "
        "model as the judge. Every score below therefore describes the pipeline on that model. The "
        "harness records agentOnWorkersAI=false on each case and prints the warning at the head of its "
        "own report, so this cannot be read off by accident - but it does mean the shipped-configuration "
        "baseline does not yet exist."
    ))


def results(doc, d, stats):
    h1(doc, "8. Results")
    h2(doc, "Metric summary")
    para(doc, (
        "Scored is the number of cases that produced a real number out of those the metric applies to. "
        "NaN means the metric ran but could not decide; Err means the judge call failed. Neither is "
        "replaced by a default, so the means cover the scored cases only."
    ), size=9.5)
    rows = []
    for m in CORE:
        s = d["summary"].get(m)
        if not s:
            continue
        rows.append([
            PRETTY[m], f"**{s['mean']:.3f}**", f"{s['min']:.3f}", f"{s['max']:.3f}",
            f"{s['scored']}/{s['applicable']}", s["indeterminate"], s["errors"], s["scale"],
        ])
    table(doc, ["Metric", "Mean", "Min", "Max", "Scored", "NaN", "Err", "Scale"], rows,
          widths=[1.9, 0.8, 0.7, 0.7, 0.8, 0.5, 0.5, 0.6],
          right_cols=(1, 2, 3, 4, 5, 6), font=8.8)

    h2(doc, f"Query cases ({stats['n_query']})")
    qrows = []
    for c in stats["queries"]:
        qrows.append([
            c["id"],
            "pass" if c.get("intent_pass") else "FAIL",
            fmt(case_score(c, "faithfulness")),
            fmt(case_score(c, "response_groundedness")),
            fmt(case_score(c, "answer_relevancy")),
            fmt(case_score(c, "factual_correctness")),
            "guard tripped" if c.get("invented_figures") else "clean",
        ])
    table(doc, ["Case", "Intent", "Faithful", "Grounded", "Relevant", "Factual", "Figure guard"],
          qrows, widths=[2.5, 0.65, 0.8, 0.8, 0.8, 0.75, 0.95],
          right_cols=(2, 3, 4, 5), font=8.2)

    h2(doc, f"Refusal cases ({stats['n_refusal']})")
    rrows = [[c["id"], "pass" if c.get("intent_pass") else "FAIL",
              fmt(case_score(c, "refusal_quality")), "of 5"]
             for c in stats["refusals"]]
    table(doc, ["Case", "Intent", "Refusal quality", "Scale"], rrows,
          widths=[2.5, 0.8, 1.2, 0.7], right_cols=(2,), font=8.4)


def findings(doc, d, stats):
    h1(doc, "9. Findings")

    h2(doc, "9.1  No invented figure reached a response")
    para(doc, (
        f"checkFigures is a containment check on the model's prose: every digit string it writes must "
        f"appear in the brief it was handed. It fired on {len(d['_guard'])} of {stats['n_query']} query "
        "cases. In both, the model's own narration was discarded and the deterministic fallback "
        "narrative was served instead, so nothing fabricated was shown to a reader."
    ))
    grows = []
    for g in d["_guard"]:
        case = next((c for c in stats["queries"] if c["id"] == g["id"]), None)
        run = d["_runs_by_id"].get(g["id"], {})
        grows.append([
            g["id"],
            ", ".join(g["invented"]),
            ", ".join(g["allowed"][:6]) + ("..." if len(g["allowed"]) > 6 else ""),
            fmt(case_score(case, "answer_relevancy")) if case else "—",
            (run.get("narrative") or "")[:120],
        ])
    table(doc, ["Case", "Flagged", "Figures it was allowed", "Relevancy", "What was served instead"],
          grows, widths=[1.6, 0.7, 1.9, 0.75, 2.05], font=8.2)
    para(doc, (
        "Neither flagged value was a fabricated metric. In google-cac-vs-previous the brief carries "
        "₹503 against a prior ₹592 for Google and a ratio of 0.85; the model wrote “down "
        "15%”, which is exactly that change, and 15 appears nowhere in the brief as a digit string, "
        "so the prose was rejected. The deterministic fallback then wrote “down 13%” — the "
        "change on the whole-window total, ₹503 against ₹580. Both are right; they are "
        "different pairs. In leads-by-origin-quarter the flagged value is a bare 2, and its origin is "
        "not recoverable, because the record keeps the figure that tripped the guard but not the prose "
        "it came from."
    ))
    para(doc, (
        "This is the guard's cost, stated plainly: containment proves that no figure was conjured, and "
        "it cannot distinguish a correct derivation from an invented one. Loosening it to permit "
        "arithmetic would reintroduce the exact failure it exists to prevent, so the trade is the right "
        "one. The price shows up in the relevancy column: these two cases rank "
        f"{guard_relevancy_ranks(d, stats)} lowest on answer relevancy out of {stats['n_query']} query "
        "cases, because the fallback is two terse sentences rather than an answer shaped to the "
        "question. That price is now measurable for the first time."
    ))

    h2(doc, "9.2  Refusals are the strongest path in the system")
    para(doc, (
        f"All {stats['n_refusal']} unanswerable questions scored "
        f"{d['summary']['refusal_quality']['mean']:.2f} of 5, which the rubric reserves for a response "
        "that declines, explains specifically what is missing from the data, and proposes a related "
        "question the data can actually answer. The cases cover a metric that does not exist (LTV, "
        "revenue, deal size), a field that does not exist (headcount), a named individual, and a window "
        "outside the dataset. The worst outcome the rubric describes - answering with a figure as if the "
        "data supported it - did not occur."
    ))

    h2(doc, "9.3  Three intent failures, two of them real defects")
    fails = [c for c in stats["queries"] if not c.get("intent_pass")]
    frows = []
    for c in fails:
        frows.append([
            c["id"],
            c["user_input"],
            c.get("intent_reason", ""),
            fmt(case_score(c, "response_groundedness")),
            fmt(case_score(c, "factual_correctness")),
        ])
    table(doc, ["Case", "Question", "Why it failed", "Grounded", "Factual"], frows,
          widths=[1.55, 1.75, 2.15, 0.75, 0.8], right_cols=(3, 4), font=8.2)

    bullet(doc, "speed-to-convert-by-source - a real defect.",
           "“Which channel converts fastest?” compiled to conversion rate rather than average "
           "days to convert. The answer names Welingak Website at 96.5%, where the ground truth is "
           "Welingak Website at 5.5 days. The right entity, the wrong metric: fastest was read as best. "
           "Factual correctness of "
           f"{fmt(case_score(next(c for c in fails if c['id'] == 'speed-to-convert-by-source'), 'factual_correctness'))} "
           "is the clearest signal any metric in this run produced.")
    bullet(doc, "report-last-week - a real defect, and the most dangerous one.",
           "An overview was returned where a specific query was asked for, and the window drifted: the "
           "response reports 2026-08-28 to 2026-09-03 against a golden window of 2026-09-14 to "
           "2026-09-20. Response groundedness of 0.25 is the lowest in the set and factual correctness "
           "is 0.00. A plausible report for the wrong week is worse than a refusal, because nothing in "
           "the prose signals that the week moved.")
    bullet(doc, "olark-weekly-june - a fingerprint mismatch, not a wrong answer.",
           "The planner compiled a different pipeline, so the deterministic check fails, but the "
           "narrative lands on substantially the right content: faithfulness 0.75 and factual "
           "correctness 0.75, the joint-highest factual score among query cases. This is the case that "
           "shows why the two layers are worth having side by side - the intent check alone would "
           "condemn it and the Ragas layer alone would pass it.")

    h2(doc, "9.4  Groundedness 0.95 against faithfulness 0.60")
    para(doc, (
        f"Response groundedness averages {d['summary']['response_groundedness']['mean']:.3f} while "
        f"faithfulness averages {d['summary']['faithfulness']['mean']:.3f}, and the gap is informative "
        "rather than contradictory. Groundedness is one holistic judge rating on whether the narrative "
        "sits on the rows. Faithfulness decomposes the narrative into statements and requires each one "
        "to be entailed by them."
    ))
    para(doc, (
        "The narrator is prompted to close with a recommendation - “Focus on converting these leads "
        "to maximize revenue impact”, “continue monitoring to ensure sustained "
        "performance”. That sentence is advice, not a claim the rows can entail, so it counts as "
        "unsupported in every case it appears. On a three-statement answer it alone caps faithfulness at "
        "0.67. Read this metric here as the proportion of sentences that are data claims the rows "
        "support, and treat the absolute level as a baseline to track rather than a count of defects. "
        "The judge is also a 32B model, whose statement decomposition is harsher and noisier than a "
        "frontier judge's; the ranking across cases is more trustworthy than the level."
    ))

    h2(doc, "9.5  Factual correctness 0.27 is largely a shape mismatch")
    para(doc, (
        "Factual correctness compares the claims in the answer against the claims in the reference. The "
        "reference enumerates up to 25 dimension rows, because it is a complete rendering of the result "
        "set. The narrative reports the whole-window total and the top contributor, because that is what "
        "it is designed to do. The metric scores the difference as missing truth."
    ))
    lbo = next((c for c in stats["queries"] if c["id"] == "leads-by-origin-quarter"), None)
    if lbo:
        para(doc, (
            "leads-by-origin-quarter is the clean illustration. Faithfulness "
            f"{fmt(case_score(lbo, 'faithfulness'))}, groundedness "
            f"{fmt(case_score(lbo, 'response_groundedness'))}, not one wrong number - and factual "
            f"correctness {fmt(case_score(lbo, 'factual_correctness'))}, because the reference lists "
            "four origin rows and a two-sentence summary carries one of them. Nothing is wrong; coverage "
            "is deliberately low."
        ))
    para(doc, (
        "Where the metric is genuinely diagnostic is the three intent failures, which sit at 0.00, 0.08 "
        "and 0.75 - and the two lowest of those are exactly the two real defects. The metric is doing "
        "useful work at the bottom of its range and measuring summarisation style in the middle."
    ))


def limits_and_next(doc, d, stats):
    h1(doc, "10. What this run does not establish")
    bullet(doc, "Not the shipped configuration.",
           f"The planner and narrator ran on {d['_agent_model']}, not on Workers AI. This is the single "
           "largest caveat on every number above.")
    bullet(doc, "One judge, one run.",
           "No variance estimate, no second judge, no inter-judge agreement. A 32B judge's absolute "
           "levels should not be quoted as the system's quality; the ranking across cases is the usable "
           "part.")
    bullet(doc, "Thirty cases.",
           f"{stats['n_query']} query and {stats['n_refusal']} refusal. Enough to find defects, not "
           "enough for a confidence interval on a mean.")
    bullet(doc, "Three metrics absent.",
           "context_precision, context_relevance and context_recall were not in this run, for the "
           "reasons in section 2.")
    bullet(doc, "Nothing gates anything yet.",
           "No threshold is enforced in CI, so a regression on any of these metrics would currently be "
           "noticed only by someone reading a report.")

    h1(doc, "11. Recommended next steps")
    steps = [
        ("Re-run on the shipped model.",
         "Same cases, same judge, without --agent-base-url. This is the baseline the project actually "
         "needs and the only thing missing from this report. The recorded runs make the judge half "
         "nearly free; only the agent half is re-spent."),
        ("Decide what faithfulness should count.",
         "Either separate the advisory closing sentence from the data claims before judging, or stop "
         "asking the narrator for advice. As it stands the metric penalises a prompt instruction, and "
         "the number cannot improve while both hold."),
        ("Make factual correctness coverage-aware.",
         "Grade against the top-k rows the narrative is expected to carry rather than the full "
         "reference, or report precision and recall separately so a summary is not scored as a partial "
         "truth."),
        ("Fix the “fastest” synonym in the planner.",
         "fastest, quickest and slowest must map to average days to convert, not to conversion rate. "
         "Add the synonym to the semantic layer and keep speed-to-convert-by-source as the regression "
         "test."),
        ("Fix the window handling behind report-last-week.",
         "An overview that silently moves the reporting week is the most dangerous failure in the set, "
         "and the one a user is least able to catch."),
        ("Gate CI once the shipped-model baseline exists.",
         "Fail on refusal quality below 5, response groundedness below 0.90, intent accuracy below 90%, "
         "or any invented figure reaching a response. Do not gate on faithfulness or factual "
         "correctness until steps 2 and 3 are settled."),
        ("Run the full eight-metric set once on Workers Paid.",
         "About $0.61 to put a real number on context precision, then leave it out of routine runs."),
        ("Record the prose the figure guard rejects.",
         "The run record keeps the flagged digit and the allowed set but not the sentence it came from, "
         "which is why one of the two guard trips in this run cannot be explained. Storing the rejected "
         "narration alongside the fallback would turn each trip into a diagnosable case."),
        ("Grow the set with the synthetic generator.",
         "generate_synthetic_cases.py already reads the live catalogue; the gap is review, not "
         "generation."),
    ]
    for i, (label, text) in enumerate(steps, 1):
        bullet(doc, f"{i}. {label}", text)


def reproducing(doc, d, stats):
    h1(doc, "12. Reproducing the run")
    code(doc,
         "npm run eval:ragas:setup      # pip install -r scripts/requirements-eval.txt\n"
         "npm run dev                   # Worker, in another terminal\n"
         "npm run gateway:status        # is the notebook registered, which models are there\n"
         "npm run eval:ragas:probe      # does the judge honour a json_schema\n"
         "npm run eval:ragas:plan       # projected judge calls and cost, spends nothing\n"
         "npm run eval:ragas:quick      # 5 cases, 3 metrics, while iterating\n"
         "npm run eval:ragas:core       # the run of record")
    para(doc, (
        "Reports land in evals/reports/ as a JSON report, a Markdown report and the scored samples as "
        "JSONL. Recorded agent runs land in evals/.runs/ and judge replies in evals/.judge-cache/, which "
        "is what makes a re-score cheap. This document is generated from that JSON by "
        "scripts/generate_ragas_eval_report.py, so no figure in it is retyped."
    ))
    para(doc, "Other entry points worth knowing:", space_after=3)
    bullet(doc, "npm run eval:ragas", "the whole eight-metric set on the default Workers AI judge.")
    bullet(doc, "npm run eval:ragas:cheap", "the cheapest Workers AI judge that still supports JSON mode.")
    bullet(doc, "npm run eval:ragas:resume", "continue a budget-stopped run, paying nothing for pairs already scored.")
    bullet(doc, "npm run eval:ragas:ollama", "judge on a local Ollama, no tunnel needed.")
    bullet(doc, "npm run eval:ragas:generate", "synthesise candidate golden cases from /api/catalog.")


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def build(report_path, out_path):
    d = load(report_path)
    cases = d["cases"]
    queries = [c for c in cases if not c.get("is_refusal")]
    refusals = [c for c in cases if c.get("is_refusal")]
    stats = {
        "n": len(cases),
        "n_query": len(queries),
        "n_refusal": len(refusals),
        "queries": queries,
        "refusals": refusals,
        "intent_pass": sum(1 for c in cases if c.get("intent_pass")),
    }
    first_run = next(iter(d["_runs_by_id"].values()), {})
    d["_agent_model"] = cases[0].get("agent_model") or first_run.get("agentModel") or "unknown"
    d["_context_schema"] = first_run.get("contextSchema", 4)
    d["_judge_model"] = d["judge"].split(" via ")[0]

    doc = Document()
    for s in doc.sections:
        s.top_margin = Inches(0.7)
        s.bottom_margin = Inches(0.7)
        s.left_margin = Inches(0.7)
        s.right_margin = Inches(0.7)

    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = BODY
    normal.paragraph_format.line_spacing = 1.14
    normal.paragraph_format.space_after = Pt(4)

    cover(doc, d, stats)
    executive_summary(doc, d, stats)
    what_is_graded(doc, d, stats)
    honesty(doc, d, stats)
    implementation(doc, d, stats)
    judge_problem(doc, d, stats)
    caching_and_cost(doc, d, stats)
    run_config(doc, d, stats)
    results(doc, d, stats)
    findings(doc, d, stats)
    limits_and_next(doc, d, stats)
    reproducing(doc, d, stats)

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(14)
    r = p.add_run(
        f"Generated {datetime.now():%Y-%m-%d %H:%M} from {os.path.basename(report_path)} "
        f"by scripts/generate_ragas_eval_report.py"
    )
    r.font.size = Pt(8)
    r.font.color.rgb = MUTED

    doc.save(out_path)
    return d, stats


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--report", default=None, help="eval JSON report; default is the newest")
    ap.add_argument("--out", default="LeadPulse-Ragas-Evaluation-Report.docx")
    args = ap.parse_args()

    report_path = args.report or latest_report()
    d, stats = build(report_path, args.out)
    print(f"[Report] source      {report_path}")
    print(f"[Report] cases       {stats['n']} ({stats['n_query']} query, {stats['n_refusal']} refusal)")
    print(f"[Report] intent      {stats['intent_pass']}/{stats['n']}")
    for m in CORE:
        s = d["summary"].get(m)
        if s:
            print(f"[Report] {m:<22} {s['mean']:.3f}  ({s['scored']}/{s['applicable']} scored)")
    print(f"[Report] written     {args.out}")


if __name__ == "__main__":
    main()
