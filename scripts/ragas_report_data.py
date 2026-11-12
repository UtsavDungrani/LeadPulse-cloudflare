"""Reading an eval run back off disk, for the Ragas report.

Everything the Word report says about a number comes through here: the JSON
report a run wrote, plus the recorded agent runs under evals/.runs/, which carry
the latency and the figure-guard outcome the JSON report does not.
"""

from __future__ import annotations

import glob
import json
import os

# --------------------------------------------------------------------------- #
# Data
# --------------------------------------------------------------------------- #

CORE = [
    "faithfulness",
    "response_groundedness",
    "answer_relevancy",
    "factual_correctness",
    "refusal_quality",
]

PRETTY = {
    "faithfulness": "Faithfulness",
    "response_groundedness": "Response groundedness",
    "answer_relevancy": "Answer relevancy",
    "factual_correctness": "Factual correctness",
    "refusal_quality": "Refusal quality",
}

DEFINITION = {
    "faithfulness": "Every claim in the narrative is entailed by the rows it was given.",
    "response_groundedness": "The narrative as a whole sits on the rows.",
    "answer_relevancy": "The narrative answers the question that was actually asked.",
    "factual_correctness": "The narrative agrees with the ground-truth answer.",
    "refusal_quality": "An unanswerable question is declined, with a way forward.",
}


def latest_report(out_dir="evals/reports"):
    found = sorted(glob.glob(os.path.join(out_dir, "ragas_eval_*.json")))
    if not found:
        raise SystemExit(f"[Error] no eval report found in {out_dir}/")
    return found[-1]


def load(report_path, runs_dir="evals/.runs"):
    with open(report_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    runs = []
    for p in sorted(glob.glob(os.path.join(runs_dir, "*.json"))):
        with open(p, "r", encoding="utf-8") as f:
            runs.append(json.load(f))

    lat = sorted(r["latencyMs"] for r in runs if r.get("latencyMs"))
    data["_latency"] = {
        "n": len(lat),
        "min": lat[0] / 1000 if lat else 0,
        "max": lat[-1] / 1000 if lat else 0,
        "mean": (sum(lat) / len(lat) / 1000) if lat else 0,
        "median": lat[len(lat) // 2] / 1000 if lat else 0,
    }
    data["_guard"] = [
        {
            "id": r["id"],
            "invented": r.get("inventedFigures") or [],
            "allowed": r.get("allowedFigures") or [],
        }
        for r in runs
        if r.get("figuresChecked") is False
    ]
    data["_runs_by_id"] = {r["id"]: r for r in runs}
    return data


def fmt(v, scale="0-1"):
    if v is None:
        return "—"
    return f"{v:.2f}" if scale == "0-1" else f"{v:.2f}"


def case_score(case, metric):
    v = (case.get("scores") or {}).get(metric)
    if v is None:
        return None
    return v


ORDINALS = {
    1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth",
    7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth",
}


def guard_relevancy_ranks(d, stats):
    """Where the figure-guard cases sit in the answer-relevancy ordering, as prose.

    Written out rather than asserted, because the first draft of this paragraph
    guessed "lowest and third-lowest" and the data said first and fifth.
    """
    scored = [
        (c["id"], case_score(c, "answer_relevancy"))
        for c in stats["queries"]
        if case_score(c, "answer_relevancy") is not None
    ]
    order = [cid for cid, _ in sorted(scored, key=lambda p: p[1])]
    words = []
    for g in d["_guard"]:
        if g["id"] in order:
            rank = order.index(g["id"]) + 1
            words.append(ORDINALS.get(rank, f"{rank}th"))
    if not words:
        return "unranked"
    if len(words) == 1:
        return words[0]
    return ", ".join(words[:-1]) + " and " + words[-1]

