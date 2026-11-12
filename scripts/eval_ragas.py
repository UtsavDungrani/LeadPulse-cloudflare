#!/usr/bin/env python3
"""
Ragas evaluation for the LeadPulse analyst pipeline.

What this grades
----------------
The intent eval (`src/evals/`) grades the *first* half of the pipeline: did the
planner turn the question into the right MongoDB query? That is a deterministic
comparison of compiled pipelines and it needs no judge.

This file grades the *second* half, which no exact comparison can reach: given
rows that are correct by construction, is the narrative the model wrote actually
supported by them? The failure mode that matters for an analytics agent is not a
clumsy sentence, it is a confident number that is not in the data. So:

  faithfulness           every claim in the narrative is entailed by the rows
  response_groundedness  the narrative as a whole sits on the rows
  answer_relevancy       the narrative answers the question that was asked
  context_relevance      the rows that were fetched bear on the question
  context_precision      the fetched rows match the rows the case says are right
  context_recall         the right rows are covered by what was fetched
  factual_correctness    the narrative agrees with the ground-truth answer
  refusal_quality        an unanswerable question is declined, with a way forward

Ground truth is not taken from the planner. For each case the golden *expected*
intent is executed against the same database, and that result set is rendered as
the `reference`. When the planner picks the wrong query the two diverge, and the
reference-based metrics are what notice.

Honesty rules
-------------
Two rules, because the previous version of this script broke both and reported a
flat 1.00 faithfulness and 0.95 relevancy for every case in the set - numbers
that were literal constants in an `except` branch, not measurements:

  1. A metric that fails is recorded as a failure, never as a score. There is no
     default value anywhere in this file.
  2. A metric that produced no usable score for any case fails the run, because
     a metric that silently does not run is worse than no metric.

Cost, and why it is in this file
--------------------------------
The binding constraint is not the judge vendor, it is Workers AI's free
allocation: 10,000 neurons a day, shared across models, reset at 00:00 UTC.

The full golden set is 481 judge calls. Context precision is why that number is
not obvious - it calls the judge once per retrieved context chunk, so it alone is
36% of the total, and answer relevancy makes `strictness` calls. At roughly
2,000 input and 300 output tokens a call that comes to about 55,000 neurons on
the 70b judge, or 5.5 days of free allocation.

There is no Workers AI judge that makes this fit in one day. The cheapest one
that still supports JSON mode is `@cf/meta/llama-3.1-8b-instruct`, and it is
only about 1.6x cheaper, not an order of magnitude: its input rate is nearly
identical to the 70b's (25,608 against 26,668) and only its output rate is much
lower (75,147 against 204,805). That is 3.5 days.

So there are three honest ways to run the whole set, none of which needs a
third-party key:

  * Across days, for free. Judge replies are deterministic at temperature 0 and
    are cached on disk by model, prompt and schema; agent runs are recorded too.
    `--reuse-runs` resumes where the last run stopped and pays nothing for the
    pairs already scored.
  * In one go on Workers Paid, for about $0.61 on the 70b or $0.39 on the 8b, at
    $0.011 per 1,000 neurons.
  * In one day on the free allocation with fewer metrics. The three that bear
    most directly on "is the narrative true" - faithfulness, answer_relevancy
    and factual_correctness - are 175 calls, about 13,000 neurons on the 8b.

`--dry-run` prints the projected call count and cost after the agent half and
before spending anything on judging, so none of this has to be guessed.
`--neuron-budget` stops short of the allocation and records the untouched pairs
as not attempted, instead of hitting a 4006 at case 20 and leaving half a report
that looks like real zeroes. An incomplete run exits 3, not 1: the scores it did
take are good, there are just fewer of them.

Judging somewhere else
----------------------
Judging is about 90% of the spend, and it does not have to run on the account
that hosts the system under test. `--judge-base-url` points it at any
OpenAI-compatible endpoint, which costs no neurons at all:

    # a GPU notebook (Kaggle, Colab) exposed through a tunnel
    python scripts/eval_ragas.py --probe-judge         --judge-base-url https://<tunnel-host> --judge-model qwen2.5:32b

    python scripts/eval_ragas.py         --judge-base-url https://<tunnel-host> --judge-model qwen2.5:32b

    # or Ollama on this machine, which needs no tunnel at all
    python scripts/eval_ragas.py         --judge-base-url http://127.0.0.1:11434 --judge-model qwen2.5:32b

`/v1` is appended when missing, because Ollama, vLLM and llama.cpp all serve the
OpenAI surface there and the resulting 404 reads like a tunnel fault.

Leave the embeddings on Workers AI. They are one metric's worth of short strings
and bge-m3 is 1,075 neurons per million tokens, so moving them saves nothing and
costs you a second model to host. With the judge external, the only Workers AI
spend left is the agent half - about 5,700 neurons for all 31 cases, comfortably
inside one free day - so the whole suite becomes a single free run.

Run `--probe-judge` against a new endpoint first. The dangerous failure is not a
refused connection, it is an endpoint that accepts `response_format` and ignores
it: Ollama *Cloud* does precisely that, taking a json_schema without complaint
and applying no grammar-constrained decoding. Self-hosted Ollama 0.5+ does
enforce it. An endpoint that quietly ignores the schema is how this suite came to
report invented scores in the first place, so it is worth two seconds to check.

Judge model
-----------
Ragas 0.4 metrics are structured-output metrics: each judge call asks for a
specific JSON shape. With `OPENAI_API_KEY` set, the standard OpenAI path is
used. Without one, the judge is Workers AI reached through the Worker's
OpenAI-compatible routes (`/api/eval/chat/completions`, `/api/eval/embeddings`),
with JSON-schema-constrained decoding, so the suite needs no third-party key.

Usage
-----
  npm run dev                               # Worker, in another terminal
  npm run eval:ragas                        # whole golden set
  npm run eval:ragas:cheap                  # cheapest JSON-mode judge (~1.6x cheaper)
  npm run eval:ragas:resume                 # continue a budget-stopped run for free
  python scripts/eval_ragas.py --limit 5    # a slice, while iterating
  python scripts/eval_ragas.py --reuse-runs --metrics faithfulness
                                            # re-score without re-running the agent
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import sys
import typing as t
from datetime import datetime
from pathlib import Path

import requests
from ragas.embeddings import BaseRagasEmbedding
from ragas.llms.base import InstructorBaseRagasLLM


# --------------------------------------------------------------------------- #
# Environment
# --------------------------------------------------------------------------- #

def load_dev_vars(path: str = ".dev.vars") -> None:
    """Load the Worker's local env file, without overriding a real environment."""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v.strip().strip("\"'"))


load_dev_vars()

WORKER_URL = os.environ.get("EVAL_WORKER_URL", "http://127.0.0.1:8787").rstrip("/")
JUDGE_MODEL = os.environ.get("RAGAS_JUDGE_MODEL", "@cf/meta/llama-3.3-70b-instruct-fp8-fast")
EMBED_MODEL = os.environ.get("RAGAS_EMBED_MODEL", "@cf/baai/bge-m3")
OPENAI_JUDGE_MODEL = os.environ.get("RAGAS_MODEL", "gpt-4o-mini")
OPENAI_EMBED_MODEL = os.environ.get("RAGAS_OPENAI_EMBED_MODEL", "text-embedding-3-small")


class JudgeError(RuntimeError):
    """The judge could not be made to return the shape a metric asked for."""


class EndpointDown(BaseException):
    """
    The judge endpoint stopped answering, so the rest of the run cannot happen.

    Separate from JudgeError, which means the model replied with something
    unusable - a real measurement that failed. This means no measurement was
    taken at all, and every remaining pair would fail the same way. A tunnelled
    model on a borrowed GPU disappears mid-run routinely: the first attempt at
    this suite died with Cloudflare error pages, the second with connection
    errors, both around two thirds of the way through. Grinding out 96 identical
    failures afterwards wastes an hour and buries the one fact that matters.

    BaseException for the same reason as BudgetExhausted: several ragas metrics
    catch bare `Exception` and turn it into a NaN score, which would report a
    dead endpoint as a judge that could not decide.
    """


class BudgetExhausted(BaseException):
    """
    The neuron budget ran out. Distinct from a failure: the work is unfinished.

    Deliberately derived from BaseException rather than Exception. Several ragas
    metrics wrap their judge call in a bare `except Exception` and convert any
    failure into a NaN score - `ResponseGroundedness._get_judge_rating` and
    `ContextRelevance._get_judge_rating` both do. Inheriting from Exception
    would therefore turn "the allocation ran out" into "the judge could not
    decide", which is a measurement that was never taken being reported as one
    that was. This way the stop propagates and the pair is recorded as not
    attempted.
    """


# --------------------------------------------------------------------------- #
# Neuron accounting
# --------------------------------------------------------------------------- #
#
# Workers AI bills in neurons, and a free account gets 10,000 a day, reset at
# 00:00 UTC. That is the real constraint on this suite - not the judge vendor.
# The full golden set is about 506 judge calls (context precision alone makes
# one call per retrieved context chunk), which on the 70b judge comes to several
# times the daily allocation and dies mid-run with a 4006.
#
# So the runner measures what it spends, stops before it runs out, and caches
# every judge reply so nothing is ever paid for twice. Rates are neurons per
# million tokens, from Cloudflare's published pricing table.

NEURON_RATES: dict[str, tuple[float, float]] = {
    # model id: (input neurons per 1M tokens, output neurons per 1M tokens)
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast": (26_668, 204_805),
    "@cf/meta/llama-3.1-8b-instruct": (25_608, 75_147),
    "@cf/meta/llama-3-8b-instruct": (25_608, 75_147),
    "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": (45_170, 443_756),
    "@cf/qwen/qwen2.5-coder-32b-instruct": (60_000, 90_909),
    # embeddings: input only
    "@cf/baai/bge-m3": (1_075, 0),
    "@cf/baai/bge-small-en-v1.5": (1_841, 0),
    "@cf/baai/bge-base-en-v1.5": (6_058, 0),
    "@cf/baai/bge-large-en-v1.5": (18_582, 0),
}

# Only these support `response_format` with a JSON schema, which every Ragas
# metric needs. Picking anything else means the schema is a suggestion in the
# prompt rather than a constraint on decoding, the adapter burns its retries on
# unparseable replies, and metrics start erroring for a reason that looks like a
# model problem but is a configuration one. So an unlisted judge gets a warning.
JSON_MODE_MODELS = {
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/meta/llama-3-8b-instruct",
    "@cf/meta/llama-3.1-8b-instruct",
    "@hf/nousresearch/hermes-2-pro-mistral-7b",
    "@hf/thebloke/deepseek-coder-6.7b-instruct-awq",
    "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
}

# The cheapest judge that still supports JSON mode. Note how little the saving
# is: input is near-identical to the 70b (25,608 vs 26,668) and only output is
# materially cheaper (75,147 vs 204,805), so this is about 1.6x, not an order of
# magnitude. There is no Workers AI judge that makes the full suite fit in one
# day's free allocation on its own.
CHEAPEST_JSON_MODE_JUDGE = "@cf/meta/llama-3.1-8b-instruct"

# Must match EVAL_CONTEXT_SCHEMA in src/evals/route.ts. A recorded agent run is
# only replayable while its contexts match what the Worker produces now.
CONTEXT_SCHEMA = 4

# Filled in from /api/eval/cases; part of the run-cache identity.
CONFIGURED_AGENT_MODEL: str | None = None

FREE_DAILY_NEURONS = 10_000
NEURON_USD = 0.011 / 1000  # Workers Paid overage, per neuron


class Budget:
    """
    Tracks neuron spend across every model this run touches.

    `reserve()` is called before a request, not after, because the point is to
    stop short of the allocation rather than to discover afterwards that it was
    blown. Spend is estimated from the previous calls' average cost, which is
    close enough: the alternative is counting tokens twice, once here and once
    on Cloudflare's side.
    """

    def __init__(self, limit: float | None):
        self.limit = limit
        self.spent = 0.0
        self.tokens_in = 0
        self.tokens_out = 0
        self.calls = 0
        self.cache_hits = 0
        self.by_model: dict[str, float] = {}
        self.stopped = False
        # Why it stopped: a self-imposed cap and Cloudflare's 4006 need different
        # answers from the reader, so the distinction has to survive to the report.
        self.stop_reason: str | None = None
        # Models billed by someone other than Cloudflare, or by nobody.
        self.free_models: set[str] = set()

    def cost(self, model: str, tokens_in: int, tokens_out: int) -> float:
        # A judge running somewhere else - Ollama on a borrowed GPU, a local
        # box, another provider's free tier - spends no neurons. Its tokens are
        # still counted, because knowing the volume is what tells you whether a
        # 40-minute run is normal or a retry storm.
        if model in self.free_models:
            return 0.0
        rate_in, rate_out = NEURON_RATES.get(model, (26_668, 204_805))
        return (tokens_in / 1e6) * rate_in + (tokens_out / 1e6) * rate_out

    def reserve(self, model: str) -> None:
        """Raises BudgetExhausted when one more average-sized call would overrun."""
        # A free model can never overrun a neuron budget, so it is never gated -
        # otherwise an external judge would inherit a limit that does not apply
        # to it and stop for no reason.
        if model in self.free_models:
            return
        if self.limit is None or self.stopped:
            if self.stopped:
                raise BudgetExhausted("neuron budget already exhausted")
            return
        projected = (self.spent / self.calls) if self.calls else 0.0
        if self.spent + projected > self.limit:
            self.stopped = True
            self.stop_reason = (
                f"hit the --neuron-budget cap of {self.limit:.0f} neurons "
                f"after {self.spent:.0f}"
            )
            raise BudgetExhausted(
                f"stopping at {self.spent:.0f} of {self.limit:.0f} neurons; "
                "the next call would overrun the budget"
            )

    def record(self, model: str, tokens_in: int, tokens_out: int) -> None:
        c = self.cost(model, tokens_in, tokens_out)
        self.spent += c
        self.tokens_in += tokens_in
        self.tokens_out += tokens_out
        self.calls += 1
        self.by_model[model] = self.by_model.get(model, 0.0) + c

    def hit(self) -> None:
        self.cache_hits += 1

    def summary(self) -> dict:
        return {
            "neurons": round(self.spent, 1),
            "usd_if_paid": round(self.spent * NEURON_USD, 4),
            "pct_of_free_daily": round(self.spent / FREE_DAILY_NEURONS * 100, 1),
            "billed_calls": self.calls,
            "cache_hits": self.cache_hits,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "by_model": {k: round(v, 1) for k, v in self.by_model.items()},
            "budget": self.limit,
            "stopped_early": self.stopped,
            "stop_reason": self.stop_reason,
        }


class EndpointHealth:
    """
    Shared transport health for the judge and the embeddings.

    They are separate adapters pointed at the same host, and the failure that
    actually happens takes out both. Counting per-adapter already hid it once:
    every judge call was served from cache, so only the embeddings touched the
    network, and three of them failing in a row never reached the judge's own
    threshold. One counter per host is the honest unit.
    """

    def __init__(self, down_after: int = 4):
        self.down_after = down_after
        self.consecutive = 0
        self.down = False
        self.reason = None

    def ok(self):
        self.consecutive = 0

    def failed(self, where, note):
        self.consecutive += 1
        if self.consecutive >= self.down_after and not self.down:
            self.down = True
            self.reason = (
                f"{self.consecutive} consecutive transport failures ({where}) - the "
                f"endpoint or the tunnel in front of it is gone. Last error: {note}"
            )

    def check(self):
        if self.down:
            raise EndpointDown(self.reason or "the endpoint is not answering")


class JudgeCache:
    """
    Disk cache for judge replies, keyed on model + prompt + schema.

    This is what makes the suite runnable on a free account: the metrics are
    deterministic at temperature 0, so a reply is worth keeping. Scoring a few
    metrics today and the rest tomorrow costs nothing for the ones already done,
    and a crashed run resumes for free instead of re-spending the allocation.
    """

    def __init__(self, directory: Path | None):
        self.dir = directory
        if self.dir:
            self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        assert self.dir is not None
        return self.dir / f"{key}.json"

    @staticmethod
    def key(model: str, prompt: str, schema: dict) -> str:
        blob = json.dumps(
            {"model": model, "prompt": prompt, "schema": schema}, sort_keys=True
        ).encode("utf-8")
        return hashlib.sha256(blob).hexdigest()[:40]

    def get(self, key: str) -> str | None:
        if not self.dir:
            return None
        f = self._path(key)
        if not f.exists():
            return None
        try:
            return json.loads(f.read_text(encoding="utf-8"))["content"]
        except Exception:  # noqa: BLE001 - a corrupt entry is just a miss
            return None

    def put(self, key: str, content: str) -> None:
        if not self.dir:
            return
        try:
            self._path(key).write_text(
                json.dumps({"content": content}), encoding="utf-8"
            )
        except Exception:  # noqa: BLE001 - caching is an optimisation, not a contract
            pass


# --------------------------------------------------------------------------- #
# Judge LLM over the Worker's OpenAI-compatible route
# --------------------------------------------------------------------------- #

def _inline_refs(schema: dict) -> dict:
    """
    Resolve `$ref`/`$defs` into a single self-contained JSON Schema.

    Ragas response models nest (`NLIStatementOutput` holds a list of
    `StatementFaithfulnessAnswer`), so Pydantic emits `$defs` and `$ref`.
    Constrained decoders generally want one flat schema, and a decoder that
    silently ignores a `$ref` produces output that fails validation - which is
    the shape of bug this file exists to avoid.
    """
    defs = schema.get("$defs", {})

    def walk(node: t.Any) -> t.Any:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/$defs/"):
                target = defs.get(ref.split("/")[-1], {})
                merged = {k: v for k, v in node.items() if k != "$ref"}
                return walk({**target, **merged})
            return {k: walk(v) for k, v in node.items() if k != "$defs"}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(schema)


def _short_error(err: Exception) -> str:
    """
    One readable line from an exception, even when the body is an HTML error page.

    A dead tunnel answers with Cloudflare's branded error document, which the
    OpenAI client wraps verbatim. Several hundred lines of markup per failure
    buries the one fact that matters - that the request never reached the model -
    so it is detected and named here instead.
    """
    text = str(err)
    low = text.lower()
    if "<!doctype html" in low or "<html" in low:
        if "cloudflare tunnel error" in low:
            return (
                f"{type(err).__name__}: the tunnel returned a Cloudflare error page, "
                "so the request never reached the model. The tunnel is down, "
                "overloaded, or the request exceeded its time limit - lower "
                "--concurrency and check the tunnel is up."
            )
        return f"{type(err).__name__}: the endpoint returned an HTML error page, not JSON"
    return f"{type(err).__name__}: {text}"[:400]


def _extract_json(text: str) -> str:
    """Pull the JSON object or array out of a reply that may be fenced or prefaced."""
    s = (text or "").strip()
    if s.startswith("```"):
        s = s.split("```")[1] if "```" in s[3:] else s[3:]
        if s.lstrip().lower().startswith("json"):
            s = s.lstrip()[4:]
        s = s.strip()
    starts = [i for i in (s.find("{"), s.find("[")) if i != -1]
    if not starts:
        return s
    start = min(starts)
    closer = "}" if s[start] == "{" else "]"
    end = s.rfind(closer)
    return s[start : end + 1] if end > start else s[start:]


class SchemaJudgeLLM(InstructorBaseRagasLLM):
    """
    A Ragas structured-output LLM backed by the Worker's Workers AI proxy.

    Ragas only requires `generate`/`agenerate` taking a prompt and a Pydantic
    model, so this implements that contract directly rather than going through
    instructor, whose default OpenAI mode wants tool calling that the proxy does
    not offer. JSON-schema-constrained decoding gets to the same place with one
    round trip instead of two.

    On a reply that will not validate, the schema and the parser error are handed
    back to the model and it gets another go. If every attempt fails the call
    raises: a metric with no answer is reported as an error, never as a score.
    """

    def __init__(
        self,
        base_url: str,
        model: str,
        max_retries: int = 3,
        max_tokens: int = 3072,
        budget: "Budget | None" = None,
        cache: "JudgeCache | None" = None,
        api_key: str = "worker-internal",
        stream: bool = False,
        down_after: int = 4,
        health=None,
    ):
        from openai import AsyncOpenAI, OpenAI

        self.model = model
        self.max_retries = max_retries
        self.max_tokens = max_tokens
        self.down_after = down_after
        self.budget = budget or Budget(None)
        self.cache = cache or JudgeCache(None)
        # Streaming matters behind a Cloudflare quick tunnel: it aborts a request
        # with HTTP 524 after ~100s without a response, and a 32B model on a
        # 3,000-token judge prompt takes longer. The cap is on time to first
        # byte, so streaming converts a hard failure into a slow success.
        self.stream = stream
        # Transport failures are counted consecutively: a single blip should be
        # retried, a dead endpoint should stop the run.
        self.health = health or EndpointHealth(down_after)
        self._client = OpenAI(base_url=base_url, api_key=api_key, timeout=600.0, max_retries=2)
        self._aclient = AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=600.0, max_retries=2)
        self.calls = 0
        self.failures = 0

    def _request_kwargs(self, prompt: str, response_model: type, note: str | None) -> dict:
        schema = _inline_refs(response_model.model_json_schema())  # cheap, pure
        instruction = (
            "Reply with a single JSON object that validates against this schema. "
            "No prose, no markdown fence.\n"
            f"Schema: {json.dumps(schema)}"
        )
        if note:
            instruction += f"\n\nYour previous reply was rejected: {note}. Return corrected JSON."
        return {
            "model": self.model,
            "messages": [
                {"role": "system", "content": instruction},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0,
            "max_tokens": self.max_tokens,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": response_model.__name__,
                    "schema": schema,
                    "strict": False,
                },
            },
        }

    @staticmethod
    def _is_transport_failure(err: Exception) -> bool:
        """True when the request never reached a model."""
        name = type(err).__name__
        if name in {"APIConnectionError", "APITimeoutError", "InternalServerError", "APIStatusError"}:
            return True
        text = str(err).lower()
        return (
            "connection error" in text
            or "cloudflare tunnel error" in text
            or "<!doctype html" in text
            or "502 bad gateway" in text
            or "503 service" in text
            or "504 gateway" in text
            or " 524" in text
        )

    async def agenerate(self, prompt: str, response_model: type) -> t.Any:
        self.health.check()
        schema = _inline_refs(response_model.model_json_schema())

        # A cache hit costs nothing and spends no allocation. Only the first
        # attempt is cacheable: a retry's prompt carries the parser error, so it
        # is a different request.
        cache_key = JudgeCache.key(self.model, prompt, schema)
        cached = self.cache.get(cache_key)
        if cached is not None:
            try:
                parsed = response_model.model_validate_json(_extract_json(cached))
                self.budget.hit()
                return parsed
            except Exception:  # noqa: BLE001 - stale entry, fall through and re-ask
                pass

        note: str | None = None
        for attempt in range(1, self.max_retries + 1):
            # Checked before the request, so the run stops short of the
            # allocation instead of discovering a 4006 half way through.
            self.budget.reserve(self.model)
            self.calls += 1
            try:
                kwargs = self._request_kwargs(prompt, response_model, note)
                if self.stream:
                    raw, tin, tout = await self._stream(kwargs)
                else:
                    res = await self._aclient.chat.completions.create(**kwargs)
                    usage = getattr(res, "usage", None)
                    tin = getattr(usage, "prompt_tokens", 0) or 0
                    tout = getattr(usage, "completion_tokens", 0) or 0
                    raw = res.choices[0].message.content or ""
                self.budget.record(self.model, tin, tout)
                parsed = response_model.model_validate_json(_extract_json(raw))
                if attempt == 1:
                    self.cache.put(cache_key, raw)
                self.health.ok()
                return parsed
            except BudgetExhausted:
                raise
            except Exception as err:  # noqa: BLE001 - retried, then surfaced
                # Cloudflare's daily-allocation error is terminal for the run;
                # retrying it just turns one clear message into many.
                if "4006" in str(err) or "daily free allocation" in str(err):
                    self.budget.stopped = True
                    self.budget.stop_reason = (
                        "Cloudflare returned 4006: the account's 10,000-neuron daily "
                        "free allocation is used up. It resets at 00:00 UTC."
                    )
                    raise BudgetExhausted(
                        "Workers AI daily allocation (10,000 neurons) is used up; "
                        "it resets at 00:00 UTC"
                    ) from err
                note = _short_error(err)

                if self._is_transport_failure(err):
                    self.health.failed(f"judge {self.model}", note)
                    self.health.check()
                    # A tunnel that is merely busy recovers in seconds, so back
                    # off rather than spending every attempt immediately.
                    await asyncio.sleep(min(2 ** attempt, 20))

                if attempt == self.max_retries:
                    self.failures += 1
                    raise JudgeError(
                        f"judge failed to produce valid {response_model.__name__} "
                        f"after {self.max_retries} attempts - last error: {note}"
                    ) from err
        raise JudgeError("unreachable")

    async def _stream(self, kwargs: dict) -> tuple[str, int, int]:
        """Reassembles a streamed completion into text plus token counts."""
        parts: list[str] = []
        tin = tout = 0
        resp = await self._aclient.chat.completions.create(
            **kwargs, stream=True, stream_options={"include_usage": True}
        )
        async for chunk in resp:
            if getattr(chunk, "usage", None):
                tin = getattr(chunk.usage, "prompt_tokens", 0) or tin
                tout = getattr(chunk.usage, "completion_tokens", 0) or tout
            for choice in getattr(chunk, "choices", None) or []:
                piece = getattr(getattr(choice, "delta", None), "content", None)
                if piece:
                    parts.append(piece)
        return "".join(parts), tin, tout

    def generate(self, prompt: str, response_model: type) -> t.Any:
        return asyncio.run(self.agenerate(prompt, response_model))


class CompatEmbeddings(BaseRagasEmbedding):
    """
    Ragas embeddings over the Worker's `/api/eval/embeddings` route.

    Answer relevancy needs vectors: the judge reverse-engineers questions from
    the answer and the metric is their cosine similarity to the real question.
    Batching matters because that is `strictness` embeddings per sample.
    """

    def __init__(
        self,
        base_url: str,
        model: str,
        budget: "Budget | None" = None,
        health=None,
    ):
        from openai import AsyncOpenAI, OpenAI

        super().__init__(cache=None)
        self.model = model
        self.budget = budget or Budget(None)
        self.health = health or EndpointHealth()
        self._client = OpenAI(base_url=base_url, api_key="worker-internal", timeout=120.0, max_retries=2)
        self._aclient = AsyncOpenAI(base_url=base_url, api_key="worker-internal", timeout=120.0, max_retries=2)

    def _charge(self, texts: list[str]) -> None:
        # Workers AI returns no usage for embeddings, so this is an estimate at
        # the usual four characters per token. Embeddings are the cheapest thing
        # here by a wide margin, so an approximation is not worth more than this.
        self.budget.record(self.model, sum(len(x) for x in texts) // 4, 0)

    def embed_text(self, text: str, **kwargs: t.Any) -> list[float]:
        self.budget.reserve(self.model)
        res = self._client.embeddings.create(model=self.model, input=[text])
        self._charge([text])
        return list(res.data[0].embedding)

    async def aembed_text(self, text: str, **kwargs: t.Any) -> list[float]:
        self.health.check()
        self.budget.reserve(self.model)
        try:
            res = await self._aclient.embeddings.create(model=self.model, input=[text])
        except Exception as err:  # noqa: BLE001
            if SchemaJudgeLLM._is_transport_failure(err):
                self.health.failed(f"embeddings {self.model}", _short_error(err))
                self.health.check()
            raise
        self.health.ok()
        self._charge([text])
        return list(res.data[0].embedding)

    def embed_texts(self, texts: list[str], **kwargs: t.Any) -> list[list[float]]:
        self.budget.reserve(self.model)
        res = self._client.embeddings.create(model=self.model, input=list(texts))
        self._charge(list(texts))
        return [list(d.embedding) for d in sorted(res.data, key=lambda d: d.index)]

    async def aembed_texts(self, texts: list[str], **kwargs: t.Any) -> list[list[float]]:
        self.health.check()
        self.budget.reserve(self.model)
        try:
            res = await self._aclient.embeddings.create(model=self.model, input=list(texts))
        except Exception as err:  # noqa: BLE001
            if SchemaJudgeLLM._is_transport_failure(err):
                self.health.failed(f"embeddings {self.model}", _short_error(err))
                self.health.check()
            raise
        self.health.ok()
        self._charge(list(texts))
        return [list(d.embedding) for d in sorted(res.data, key=lambda d: d.index)]


def build_judge(
    worker_url: str,
    judge_model: str,
    budget: "Budget | None" = None,
    cache: "JudgeCache | None" = None,
    judge_base_url: str | None = None,
    judge_api_key: str | None = None,
    embed_base_url: str | None = None,
    embed_model: str | None = None,
    stream: bool = True,
) -> tuple[t.Any, t.Any, str]:
    """
    Returns (llm, embeddings, description).

    Three ways to get a judge, in order of precedence:

      1. `--judge-base-url` - any OpenAI-compatible endpoint. A self-hosted
         Ollama, vLLM or llama.cpp server, or another provider's free tier. This
         costs no Workers AI neurons, which is the whole point: judging is ~90%
         of the suite's spend and it does not have to run on the same account as
         the system under test.
      2. `OPENAI_API_KEY` - the standard OpenAI path.
      3. The Worker's own Workers AI proxy, which needs no extra key at all.

    The judge and the embeddings are chosen separately, because they are not
    comparable costs. Embeddings are one metric's worth of short strings - on
    bge-m3 that is 1,075 neurons per million tokens, a rounding error - so the
    sensible default is to leave them on Workers AI and move only the judge.
    """
    emb_model = embed_model or EMBED_MODEL
    worker_base = f"{worker_url}/api/eval"

    # Embeddings: wherever asked, else the Worker.
    health = EndpointHealth()
    emb_base = embed_base_url or worker_base
    if embed_base_url and budget is not None:
        # Same reasoning as the judge: somebody else's endpoint spends no
        # neurons. Without this the model falls through to the default rate and
        # gets billed as though it were the 70b.
        budget.free_models.add(emb_model)
    embeddings = CompatEmbeddings(emb_base, emb_model, budget=budget, health=health)

    if judge_base_url:
        base = judge_base_url.rstrip("/")
        # Ollama, vLLM and llama.cpp all serve the OpenAI surface under /v1.
        # Appending it is what people forget, and the resulting 404 reads like a
        # tunnel problem rather than a path problem.
        if not base.endswith("/v1") and "/v1" not in base:
            base = f"{base}/v1"
        if budget is not None:
            budget.free_models.add(judge_model)
        llm = SchemaJudgeLLM(
            base, judge_model, budget=budget, cache=cache,
            api_key=judge_api_key or "not-needed",
            # On by default for an external endpoint, which is the case where a
            # tunnel or proxy in front of a slow model imposes a TTFB timeout.
            stream=stream,
            health=health,
        )
        return llm, embeddings, f"{judge_model} via {base} (external, no neurons) / {emb_model}"

    openai_key = os.environ.get("OPENAI_API_KEY")
    if openai_key:
        from openai import AsyncOpenAI
        from ragas.embeddings import OpenAIEmbeddings
        from ragas.llms import llm_factory

        client = AsyncOpenAI(api_key=openai_key)
        llm = llm_factory(OPENAI_JUDGE_MODEL, provider="openai", client=client)
        if embed_base_url is None:
            embeddings = OpenAIEmbeddings(client=client, model=OPENAI_EMBED_MODEL)
            return llm, embeddings, f"OpenAI {OPENAI_JUDGE_MODEL} / {OPENAI_EMBED_MODEL}"
        return llm, embeddings, f"OpenAI {OPENAI_JUDGE_MODEL} / {emb_model} via {emb_base}"

    return (
        SchemaJudgeLLM(worker_base, judge_model, budget=budget, cache=cache),
        embeddings,
        f"Workers AI {judge_model} / {emb_model} via {worker_base}",
    )


async def probe_judge(llm: t.Any, label: str) -> bool:
    """
    Asks the judge for one small structured reply and checks it validates.

    Worth its own step because the dangerous failure is not a refused
    connection, it is an endpoint that accepts `response_format` and ignores it.
    Ollama Cloud does exactly that - it takes a json_schema without complaint
    and applies no grammar-constrained decoding - and so does any proxy that
    drops the field, which is how this suite came to report invented scores in
    the first place. A tunnel to a GPU is worth two seconds of checking before
    a run that takes an hour.
    """
    from pydantic import BaseModel, Field

    class Probe(BaseModel):
        city: str = Field(description="the capital city named in the question")
        population_millions: float = Field(description="a number, even if approximate")
        landlocked: bool = Field(description="whether the country has no coastline")

    print(f"[Probe] asking {label} for a schema-constrained reply...")
    try:
        out = await llm.agenerate(
            "What is the capital of Switzerland, roughly how many million people "
            "live in it, and is Switzerland landlocked?",
            Probe,
        )
    except Exception as err:  # noqa: BLE001
        print(f"[Probe] FAILED: {type(err).__name__}: {err}", file=sys.stderr)
        print("[Probe] The judge cannot return the shapes the metrics ask for. "
              "Fix this before running - every metric would error.", file=sys.stderr)
        return False

    print(f"[Probe] ok: {out.model_dump()}")
    print("[Probe] The endpoint returns valid structured output. Note this proves "
          "the shape, not that decoding is schema-constrained;")
    print("        a model that happens to answer in JSON will pass too. Watch the "
          "error count on the first real run.")
    return True


# --------------------------------------------------------------------------- #
# Metric wiring
# --------------------------------------------------------------------------- #

REFUSAL_RUBRIC = {
    "score1_description": (
        "The response answers the question with a figure, trend or ranking, as if the data "
        "supported it. This is the worst outcome: an invented number presented as fact."
    ),
    "score2_description": (
        "The response neither answers nor clearly declines. It is evasive, or it hedges in a "
        "way that leaves the reader thinking an answer may exist."
    ),
    "score3_description": (
        "The response declines to answer but gives no reason, so the reader cannot tell "
        "whether the question was unanswerable or merely misunderstood."
    ),
    "score4_description": (
        "The response declines and explains that the requested metric, field or period is not "
        "in the available data, but offers nothing the reader could ask instead."
    ),
    "score5_description": (
        "The response declines, explains specifically what is missing from the data, and "
        "proposes a related question the data can actually answer."
    ),
}

# name -> (needs_reference, applies_to)
#   "query"   graded on cases the planner answered with data
#   "refusal" graded on cases the planner declined
METRIC_SPEC: dict[str, tuple[bool, str]] = {
    "faithfulness": (False, "query"),
    "response_groundedness": (False, "query"),
    "answer_relevancy": (False, "query"),
    "context_relevance": (False, "query"),
    "context_precision": (True, "query"),
    "context_recall": (True, "query"),
    "factual_correctness": (True, "query"),
    "refusal_quality": (False, "refusal"),
}

DEFAULT_METRICS = list(METRIC_SPEC.keys())

# The metrics that carry information for *this* system, and nothing else.
#
# Three of the eight are dropped, for two different reasons:
#
#   context_relevance, context_recall - both returned exactly 1.000 on every
#     case that scored, across three independent runs. That is not a good score,
#     it is no signal: retrieval here is a deterministic semantic layer compiled
#     from a validated intent, not a learned retriever, so there is nothing for
#     them to catch. A metric that cannot vary cannot regress.
#   context_precision - the honest reason is cost. It calls the judge once per
#     retrieved context chunk, which is roughly a third of every judge call the
#     suite makes, and what it measures is partly how the Worker chunks its
#     narration brief rather than how the agent behaves. Worth running
#     deliberately; not worth paying for on every run.
#
# What is left is the question the eval exists to answer: is the narrative true,
# does it address what was asked, and are unanswerable questions declined well.
# At ~9 judge calls per query case this finishes in about 40 minutes rather than
# 2.5 hours - which matters when the endpoint serving it is a tunnel that has
# died three times mid-run.
CORE_METRICS = [
    "faithfulness",
    "response_groundedness",
    "answer_relevancy",
    "factual_correctness",
    "refusal_quality",
]

# Judge calls per applicable sample, read off the metric implementations in
# ragas 0.4. These are what make the suite expensive, and context precision is
# the reason the total is not obvious: it calls the judge once per retrieved
# context chunk, so its cost scales with how finely the context is split.
#   int  -> a fixed number of calls
#   "ctx" -> one call per retrieved context chunk
METRIC_CALLS: dict[str, int | str] = {
    "faithfulness": 2,            # statement generation, then NLI
    "response_groundedness": 2,   # dual judge
    "answer_relevancy": 3,        # strictness=3 generated questions
    "context_relevance": 2,       # dual judge
    "context_precision": "ctx",   # one per chunk
    "context_recall": 1,
    "factual_correctness": 2,     # claim decomposition both directions
    "refusal_quality": 1,
}


def projected_calls(samples: list[dict], metric_names: list[str]) -> int:
    """Judge calls the scoring pass will make, before making any of them."""
    total = 0
    for s in samples:
        for name in metric_names:
            if metric_args(name, s) is None:
                continue
            cost = METRIC_CALLS.get(name, 1)
            total += len(s.get("retrieved_contexts") or []) if cost == "ctx" else int(cost)
    return total


def build_metrics(names: list[str], llm: t.Any, embeddings: t.Any) -> dict[str, t.Any]:
    from ragas.metrics.collections import (
        AnswerRelevancy,
        ContextPrecisionWithReference,
        ContextRecall,
        ContextRelevance,
        Faithfulness,
        FactualCorrectness,
        ResponseGroundedness,
        RubricsScoreWithoutReference,
    )

    factories: dict[str, t.Callable[[], t.Any]] = {
        "faithfulness": lambda: Faithfulness(llm=llm),
        # max_retries=1: the adapter already retries a malformed reply, and these
        # two metrics nest their own retry loop around it. Left at the default 5
        # one bad rating can cost 15 judge calls.
        "response_groundedness": lambda: ResponseGroundedness(llm=llm, max_retries=1),
        "answer_relevancy": lambda: AnswerRelevancy(llm=llm, embeddings=embeddings),
        "context_relevance": lambda: ContextRelevance(llm=llm, max_retries=1),
        "context_precision": lambda: ContextPrecisionWithReference(llm=llm),
        "context_recall": lambda: ContextRecall(llm=llm),
        # mode="recall", not the "f1" default. The reference here is built by
        # `referenceAnswer` in the Worker and is deliberately minimal - the metric
        # and the window and the number, nothing else. F1 also penalises every
        # claim in the response that is *absent* from the reference, so the
        # narrator's "focus on converting these leads" counts as a factual error
        # and a correct answer scores 0.00. That is not factual incorrectness, it
        # is the reference being terse, and faithfulness already covers
        # unsupported claims. Recall asks the question actually worth asking: is
        # the ground truth present in what was said?
        "factual_correctness": lambda: FactualCorrectness(llm=llm, mode="recall"),
        "refusal_quality": lambda: RubricsScoreWithoutReference(
            llm=llm, rubrics=REFUSAL_RUBRIC, name="refusal_quality"
        ),
    }
    unknown = [n for n in names if n not in factories]
    if unknown:
        sys.exit(f"[Error] unknown metric(s): {', '.join(unknown)}\nAvailable: {', '.join(factories)}")
    return {n: factories[n]() for n in names}


def metric_args(name: str, sample: dict) -> dict | None:
    """The kwargs `ascore` wants, or None when this sample cannot support the metric."""
    needs_ref, applies = METRIC_SPEC[name]
    is_refusal = bool(sample["is_refusal"])
    if applies == "query" and is_refusal:
        return None
    if applies == "refusal" and not is_refusal:
        return None
    if needs_ref and not sample.get("reference"):
        return None
    if applies == "query" and not sample.get("retrieved_contexts"):
        return None
    if not sample.get("response"):
        return None

    q, a = sample["user_input"], sample["response"]
    ctx, ref = sample.get("retrieved_contexts") or [], sample.get("reference")
    return {
        "faithfulness": {"user_input": q, "response": a, "retrieved_contexts": ctx},
        "response_groundedness": {"response": a, "retrieved_contexts": ctx},
        "answer_relevancy": {"user_input": q, "response": a},
        "context_relevance": {"user_input": q, "retrieved_contexts": ctx},
        "context_precision": {"user_input": q, "reference": ref, "retrieved_contexts": ctx},
        "context_recall": {"user_input": q, "retrieved_contexts": ctx, "reference": ref},
        "factual_correctness": {"response": a, "reference": ref},
        "refusal_quality": {"user_input": q, "response": a},
    }[name]


# Metrics that do not live on 0..1. Reported on their own scale, and normalised
# only where a run-level average is shown, so the scale is never implied wrongly.
METRIC_SCALE: dict[str, tuple[float, float]] = {"refusal_quality": (1.0, 5.0)}


def normalise(name: str, value: float) -> float:
    lo, hi = METRIC_SCALE.get(name, (0.0, 1.0))
    return value if hi == 1.0 and lo == 0.0 else (value - lo) / (hi - lo)


# --------------------------------------------------------------------------- #
# Running the pipeline under test
# --------------------------------------------------------------------------- #

def fetch_golden_cases(worker_url: str) -> list[dict]:
    try:
        res = requests.get(f"{worker_url}/api/eval/cases", timeout=15)
    except Exception as e:  # noqa: BLE001
        sys.exit(
            f"[Error] could not reach {worker_url}: {e}\n"
            "Is the Worker running? Start it with: npm run dev"
        )
    if res.status_code != 200:
        sys.exit(f"[Error] /api/eval/cases returned HTTP {res.status_code}: {res.text[:300]}")
    data = res.json()
    if not data.get("ok"):
        sys.exit(f"[Error] /api/eval/cases: {data.get('error')}")
    # Stash the Worker's configured agent model so the run cache can key on it
    # even when no --agent-base-url override was passed.
    global CONFIGURED_AGENT_MODEL
    CONFIGURED_AGENT_MODEL = data.get("agentModel")
    return data.get("cases", [])


def run_case(worker_url: str, case_id: str, agent: dict | None = None) -> dict:
    """Runs one case end to end. A transport or planner failure is returned, not raised."""
    try:
        res = requests.post(
            f"{worker_url}/api/eval/end-to-end",
            json={"id": case_id, **(agent or {})},
            headers={"content-type": "application/json"},
            timeout=180,
        )
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"request failed: {e}"}
    if res.status_code != 200:
        return {"ok": False, "error": f"HTTP {res.status_code}: {res.text[:300]}"}
    try:
        return res.json()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"non-JSON response: {e}"}


def run_case_cached(
    worker_url: str, case_id: str, store: Path | None, reuse: bool,
    agent: dict | None = None,
) -> dict:
    """
    One end-to-end agent run, optionally served from disk.

    The agent half of the suite is two Workers AI calls per case (plan, then
    narrate), and re-running it to re-score a metric spends allocation on an
    answer that is already known. Keeping the responses also means a second
    scoring pass grades the *same* text, so a change in a score is a change in
    the judge and not the planner having a different day.
    """
    # The agent model is part of the cache identity: a run recorded against one
    # planner must never be served to a run asking for another, or the report
    # would attribute one model's answers to the other.
    tag = (agent or {}).get("agentModel") or CONFIGURED_AGENT_MODEL
    parts = [case_id]
    if tag:
        parts.append(tag.replace("/", "_").replace(":", "-"))
    # The context schema is part of the identity too, so a change to how the
    # Worker chunks retrieved contexts invalidates these records rather than
    # letting a replay score the previous shape.
    parts.append(f"ctx{CONTEXT_SCHEMA}")
    path = (store / f"{'__'.join(parts)}.json") if store else None
    if reuse and path and path.exists():
        try:
            cached = json.loads(path.read_text(encoding="utf-8"))
            cached["_fromCache"] = True
            return cached
        except Exception:  # noqa: BLE001 - a corrupt record is just a miss
            pass

    res = run_case(worker_url, case_id, agent)
    if path and res.get("ok"):
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(res), encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass
    return res


def to_sample(case: dict, res: dict) -> dict:
    """Flattens a case plus its Worker response into one Ragas-shaped record."""
    verdict = res.get("verdict") or {}
    return {
        "id": case["id"],
        "user_input": case["question"],
        "response": res.get("response", "") or "",
        "retrieved_contexts": res.get("retrievedContexts") or [],
        "reference": res.get("reference"),
        "reference_contexts": res.get("referenceContexts"),
        "is_refusal": bool(res.get("isRefusal", False)),
        "expected_kind": (case.get("expected") or {}).get("kind"),
        "intent_pass": bool(verdict.get("pass", False)),
        "intent_reason": verdict.get("reason", ""),
        "figures_checked": bool(res.get("figuresChecked", False)),
        "invented_figures": res.get("inventedFigures") or [],
        "latency_ms": res.get("latencyMs", 0),
        "agent_model": res.get("agentModel"),
        "agent_on_workers_ai": res.get("agentOnWorkersAI", True),
        "scores": {},
        "errors": {},
    }


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #

async def score_all(
    samples: list[dict],
    metrics: dict[str, t.Any],
    concurrency: int,
    budget: "Budget | None" = None,
) -> list[tuple[str, str]]:
    """Fills `sample["scores"]` / `sample["errors"]` in place. Never invents a value."""
    sem = asyncio.Semaphore(concurrency)
    jobs: list[tuple[dict, str, dict]] = []
    for s in samples:
        for name in metrics:
            args = metric_args(name, s)
            if args is not None:
                jobs.append((s, name, args))

    done = 0
    total = len(jobs)
    lock = asyncio.Lock()

    skipped: list[tuple[str, str]] = []
    # Shared so the first task to notice the endpoint is gone stops the others.
    endpoint_state: dict[str, str | None] = {"down": None}

    async def one(sample: dict, name: str, args: dict) -> None:
        nonlocal done
        async with sem:
            # Once the budget is gone the remaining pairs are recorded as not
            # attempted. They are neither scores nor errors: the run is
            # incomplete, and saying so is the only honest option.
            if (budget is not None and budget.stopped) or endpoint_state["down"]:
                sample.setdefault("skipped", []).append(name)
                skipped.append((sample["id"], name))
            else:
                try:
                    result = await metrics[name].ascore(**args)
                    value = float(result.value)
                    sample["scores"][name] = value
                    reason = getattr(result, "reason", None)
                    if reason:
                        sample.setdefault("reasons", {})[name] = str(reason)[:600]
                except EndpointDown as stop:
                    sample.setdefault("skipped", []).append(name)
                    skipped.append((sample["id"], name))
                    if endpoint_state["down"] is None:
                        endpoint_state["down"] = str(stop)
                        print(f"\n[Endpoint] {stop}", file=sys.stderr)
                        print("[Endpoint] Stopping here. Re-run with --reuse-runs once the "
                              "endpoint is back; cached replies make the finished pairs free.",
                              file=sys.stderr)
                except BudgetExhausted as stop:
                    sample.setdefault("skipped", []).append(name)
                    skipped.append((sample["id"], name))
                    if budget is not None and not budget.stopped:
                        budget.stopped = True
                        print(f"\n[Budget] {stop}", file=sys.stderr)
                except Exception as err:  # noqa: BLE001 - recorded, never defaulted
                    sample["errors"][name] = f"{type(err).__name__}: {err}"[:400]
        async with lock:
            done += 1
            spent = f", {budget.spent:.0f} neurons" if budget is not None else ""
            print(f"\r  scoring {done}/{total} metric calls{spent}...",
                  end="", file=sys.stderr, flush=True)

    print(f"[Ragas] {total} metric evaluations across {len(samples)} cases "
          f"(concurrency {concurrency})", file=sys.stderr)
    await asyncio.gather(*(one(s, n, a) for s, n, a in jobs))
    print("", file=sys.stderr)
    if endpoint_state["down"]:
        score_all.endpoint_down_reason = endpoint_state["down"]  # type: ignore[attr-defined]
    return skipped


def aggregate(samples: list[dict], metric_names: list[str]) -> dict[str, dict]:
    """Per-metric roll-up. `scored` counts real numbers; nothing is filled in."""
    out: dict[str, dict] = {}
    for name in metric_names:
        values = [
            s["scores"][name]
            for s in samples
            if name in s["scores"] and not math.isnan(s["scores"][name])
        ]
        indeterminate = sum(
            1 for s in samples if name in s["scores"] and math.isnan(s["scores"][name])
        )
        errors = sum(1 for s in samples if name in s["errors"])
        applicable = sum(1 for s in samples if metric_args(name, s) is not None)
        lo, hi = METRIC_SCALE.get(name, (0.0, 1.0))
        out[name] = {
            "mean": (sum(values) / len(values)) if values else None,
            "min": min(values) if values else None,
            "max": max(values) if values else None,
            "scored": len(values),
            "indeterminate": indeterminate,
            "errors": errors,
            "applicable": applicable,
            "scale": f"{lo:g}-{hi:g}",
        }
    return out


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #

def fmt(value: float | None, width: int = 8) -> str:
    return (f"{value:.3f}" if value is not None else "n/a").ljust(width)


def print_report(samples: list[dict], summary: dict[str, dict], judge: str) -> None:
    print()
    print("=" * 100)
    print("  LeadPulse Ragas Evaluation")
    print(f"  Judge: {judge}")
    agents = sorted({s.get("agent_model") or "unknown" for s in samples})
    substituted = [s for s in samples if s.get("agent_on_workers_ai") is False]
    print(f"  Pipeline under test: planner/narrator = {', '.join(agents)}")
    if substituted:
        print("  NOTE: the agent model was SUBSTITUTED. These scores describe the "
              "pipeline on that model,")
        print("        not on the Workers AI model the Worker ships with.")
    print("=" * 100)
    print(f"{'METRIC':<24} | {'MEAN':<8} | {'MIN':<8} | {'MAX':<8} | {'SCORED':<8} | "
          f"{'NaN':<5} | {'ERR':<5} | SCALE")
    print("-" * 100)
    for name, s in summary.items():
        print(
            f"{name:<24} | {fmt(s['mean'])} | {fmt(s['min'])} | {fmt(s['max'])} | "
            f"{str(s['scored']) + '/' + str(s['applicable']):<8} | "
            f"{s['indeterminate']:<5} | {s['errors']:<5} | {s['scale']}"
        )
    print("=" * 100)

    intent_pass = sum(1 for s in samples if s["intent_pass"])
    invented = [s for s in samples if s["invented_figures"]]
    print(f"  Cases evaluated:      {len(samples)}")
    print(f"  Intent accuracy:      {intent_pass}/{len(samples)} "
          f"({intent_pass / max(len(samples), 1) * 100:.1f}%)   [deterministic, not a judge]")
    print(f"  Narratives rejected for invented figures: {len(invented)}")
    for s in invented:
        print(f"      {s['id']}: {', '.join(s['invented_figures'])}")
    print("=" * 100)
    print()

    worst = sorted(
        (
            (s, name, s["scores"][name])
            for s in samples
            for name in s["scores"]
            if not math.isnan(s["scores"][name]) and normalise(name, s["scores"][name]) < 0.9
        ),
        key=lambda row: normalise(row[1], row[2]),
    )
    if worst:
        print("Lowest-scoring case/metric pairs (these are what to look at):")
        for s, name, value in worst[:15]:
            print(f"  {value:.3f}  {name:<22} {s['id']:<36} {s['user_input'][:50]}")
        print()

    errored = [(s["id"], n, e) for s in samples for n, e in s["errors"].items()]
    if errored:
        print(f"Metric errors ({len(errored)}) - these are not scores and are excluded from means:")
        for cid, name, err in errored[:15]:
            print(f"  {cid:<36} {name:<22} {err[:70]}")
        if len(errored) > 15:
            print(f"  ... and {len(errored) - 15} more")
        print()


def print_cost(
    budget: "Budget",
    samples: list[dict],
    metric_names: list[str],
    agent_neurons: float | None = None,
) -> None:
    """
    What the run cost, and what the whole set would cost.

    Printed every time, because on a free account this is the number that decides
    whether the suite is runnable at all, and guessing it wrongly is how a run
    dies at case 20.
    """
    b = budget.summary()
    print("Cost")
    print(f"  Neurons spent:        {b['neurons']:.0f}"
          f"  ({b['pct_of_free_daily']:.0f}% of the {FREE_DAILY_NEURONS}/day free allocation)")
    print(f"  If billed:            ${b['usd_if_paid']:.4f} at $0.011/1k neurons")
    print(f"  Billed model calls:   {b['billed_calls']}"
          f"   (cache hits, free: {b['cache_hits']})")
    if agent_neurons is not None:
        print(f"  Agent half:           {agent_neurons:.0f} neurons "
              f"(planning + narration; --reuse-runs makes this 0 next time)")
        print(f"  Judging:              {b['neurons'] - agent_neurons:.0f} neurons")
    print(f"  Tokens:               {b['tokens_in']} in / {b['tokens_out']} out")
    for model, spend in b["by_model"].items():
        print(f"      {model:<46} {spend:>8.0f}")

    # Projection, so the next run can be planned rather than attempted.
    attempted = sum(len(s["scores"]) + len(s["errors"]) for s in samples)
    if attempted and b["billed_calls"]:
        per_pair = b["neurons"] / attempted
        pairs_total = sum(
            1 for s in samples for n in metric_names if metric_args(n, s) is not None
        )
        print(f"  Per case/metric pair: {per_pair:.0f} neurons")
        if pairs_total:
            print(f"  Projected for all {pairs_total} pairs on this judge: "
                  f"{per_pair * pairs_total:.0f} neurons "
                  f"({per_pair * pairs_total / FREE_DAILY_NEURONS:.1f}x the daily allocation)")
        used = next(iter(b["by_model"]), "")
        if used in NEURON_RATES and used != CHEAPEST_JSON_MODE_JUDGE:
            ri, ro = NEURON_RATES[used]
            ci, co = NEURON_RATES[CHEAPEST_JSON_MODE_JUDGE]
            here = (2000 / 1e6) * ri + (300 / 1e6) * ro
            there = (2000 / 1e6) * ci + (300 / 1e6) * co
            print(f"  On {CHEAPEST_JSON_MODE_JUDGE}: about "
                  f"{per_pair * pairs_total * there / here:,.0f} neurons "
                  f"(~{here / there:.1f}x cheaper, the cheapest JSON-mode judge); "
                  "pass --judge-model")
    print("=" * 100)
    print()


def save_reports(
    samples: list[dict],
    summary: dict[str, dict],
    judge: str,
    out_dir: Path,
    cost: dict | None = None,
) -> tuple[Path, Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    md_path = out_dir / f"ragas_eval_{stamp}.md"
    json_path = out_dir / f"ragas_eval_{stamp}.json"
    ds_path = out_dir / f"ragas_samples_{stamp}.jsonl"

    intent_pass = sum(1 for s in samples if s["intent_pass"])
    metric_names = list(summary.keys())

    lines = [
        "# LeadPulse Ragas Evaluation Report",
        "",
        f"**Run:** {datetime.now().isoformat()}  ",
        f"**Judge:** {judge}  ",
        f"**Pipeline under test (planner/narrator):** "
        f"{', '.join(sorted({c.get('agent_model') or 'unknown' for c in samples}))}  ",
        f"**Cases:** {len(samples)}  ",
        f"**Intent accuracy:** {intent_pass}/{len(samples)} "
        f"({intent_pass / max(len(samples), 1) * 100:.1f}%) — deterministic pipeline comparison, not a judge",
        "",
        *(
            [
                "",
                "> **The agent model was substituted for this run.** The planner and "
                "narrator did not run on the Workers AI model the Worker ships with, "
                "so these scores describe the pipeline on the model named above. "
                "Re-run without `--agent-base-url` to measure the shipped "
                "configuration.",
            ]
            if any(c.get("agent_on_workers_ai") is False for c in samples)
            else []
        ),
        "",
        "## Metric summary",
        "",
        "`scored` is the number of cases that produced a real number out of those the metric "
        "applies to. `NaN` means the metric ran but could not decide. `err` means the judge "
        "call failed. Neither is replaced by a default — means cover `scored` cases only.",
        "",
        "| Metric | Mean | Min | Max | Scored | NaN | Err | Scale |",
        "| :--- | ---: | ---: | ---: | :---: | ---: | ---: | :--- |",
    ]
    for name, s in summary.items():
        mean = f"{s['mean']:.3f}" if s["mean"] is not None else "—"
        lo = f"{s['min']:.3f}" if s["min"] is not None else "—"
        hi = f"{s['max']:.3f}" if s["max"] is not None else "—"
        lines.append(
            f"| `{name}` | {mean} | {lo} | {hi} | {s['scored']}/{s['applicable']} | "
            f"{s['indeterminate']} | {s['errors']} | {s['scale']} |"
        )

    lines += ["", "## Case-by-case", "", "| Case | Kind | Intent | " +
              " | ".join(f"`{n}`" for n in metric_names) + " | Invented figures |",
              "| :--- | :--- | :--- | " + " | ".join("---:" for _ in metric_names) + " | :--- |"]
    for s in samples:
        cells = []
        for name in metric_names:
            if name in s["scores"]:
                v = s["scores"][name]
                cells.append("NaN" if math.isnan(v) else f"{v:.2f}")
            elif name in s["errors"]:
                cells.append("ERR")
            else:
                cells.append("—")
        lines.append(
            f"| `{s['id']}` | {'refusal' if s['is_refusal'] else 'query'} | "
            f"{'pass' if s['intent_pass'] else 'FAIL'} | " + " | ".join(cells) + " | "
            + (", ".join(s["invented_figures"]) or "none") + " |"
        )

    lines += ["", "## Details", ""]
    for s in samples:
        lines.append(f"### `{s['id']}`")
        lines.append("")
        lines.append(f"- **Question:** {s['user_input']}")
        lines.append(f"- **Response:** {s['response']}")
        if s.get("reference"):
            lines.append(f"- **Reference (golden intent executed):** {s['reference']}")
        lines.append(f"- **Intent verdict:** {'pass' if s['intent_pass'] else 'FAIL'} — {s['intent_reason']}")
        if s["invented_figures"]:
            lines.append(f"- **Invented figures:** {', '.join(s['invented_figures'])}")
        for name, reason in (s.get("reasons") or {}).items():
            lines.append(f"- **{name} rationale:** {reason}")
        for name, err in s["errors"].items():
            lines.append(f"- **{name} error:** `{err}`")
        if s["retrieved_contexts"]:
            lines.append("")
            lines.append("<details><summary>Retrieved contexts</summary>")
            lines.append("")
            lines.append("```")
            lines.append("\n---\n".join(s["retrieved_contexts"]))
            lines.append("```")
            lines.append("")
            lines.append("</details>")
        lines.append("")

    md_path.write_text("\n".join(lines), encoding="utf-8")
    json_path.write_text(
        json.dumps(
            {
                "run": datetime.now().isoformat(),
                "judge": judge,
                "cost": cost,
                "summary": summary,
                "cases": samples,
            },
            indent=2,
            default=str,
        ),
        encoding="utf-8",
    )
    with ds_path.open("w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps({
                "user_input": s["user_input"],
                "response": s["response"],
                "retrieved_contexts": s["retrieved_contexts"],
                "reference": s["reference"],
                "reference_contexts": s["reference_contexts"],
            }) + "\n")

    print(f"[Report] {md_path}")
    print(f"[Report] {json_path}")
    print(f"[Report] {ds_path}  (Ragas EvaluationDataset, for re-scoring without re-running the agent)")
    return md_path, json_path, ds_path


def sync_to_langfuse(samples: list[dict], judge: str) -> None:
    """
    Pushes each case as a Langfuse span with its Ragas scores attached.

    Uses the v3+ SDK surface (`start_observation` / `create_score`); the v2
    `langfuse.trace()` call this script used before does not exist in the
    installed SDK, so every sync silently did nothing.
    """
    pub = os.environ.get("LANGFUSE_PUBLIC_KEY")
    sec = os.environ.get("LANGFUSE_SECRET_KEY")
    if not (pub and sec):
        return
    try:
        from langfuse import Langfuse

        lf = Langfuse(public_key=pub, secret_key=sec,
                      host=os.environ.get("LANGFUSE_BASE_URL", "https://cloud.langfuse.com"))
        for s in samples:
            span = lf.start_observation(
                name=f"ragas:{s['id']}",
                as_type="span",
                input={"question": s["user_input"]},
                output={"response": s["response"]},
                metadata={
                    "judge": judge,
                    "isRefusal": s["is_refusal"],
                    "latencyMs": s["latency_ms"],
                    "inventedFigures": s["invented_figures"],
                    "metricErrors": s["errors"],
                },
            )
            # Scores hang off the trace, attached while the span is open, so a
            # case and its scores land together rather than as orphans.
            for name, value in s["scores"].items():
                if math.isnan(value):
                    continue
                span.score_trace(
                    name=name,
                    value=value,
                    data_type="NUMERIC",
                    comment=(s.get("reasons") or {}).get(name),
                )
            span.score_trace(
                name="intent_match",
                value=1 if s["intent_pass"] else 0,
                data_type="NUMERIC",
                comment=s["intent_reason"],
            )
            span.end()
        lf.flush()
        print("[Langfuse] scores recorded")
    except Exception as e:  # noqa: BLE001
        print(f"[Langfuse] sync failed: {type(e).__name__}: {e}", file=sys.stderr)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

async def run(args: argparse.Namespace) -> int:
    if args.metrics == "all":
        metric_names = DEFAULT_METRICS
    elif args.metrics == "core":
        metric_names = CORE_METRICS
    else:
        metric_names = [m.strip() for m in args.metrics.split(",") if m.strip()]

    cases = fetch_golden_cases(args.worker_url)
    if args.limit:
        cases = cases[: args.limit]
    if not cases:
        sys.exit("[Error] the golden set is empty")

    budget = Budget(None if args.neuron_budget <= 0 else float(args.neuron_budget))
    cache = JudgeCache(None if args.no_judge_cache else Path(args.judge_cache))
    run_store = None if args.no_run_cache else Path(args.run_cache)

    llm, embeddings, judge = build_judge(
        args.worker_url,
        args.judge_model,
        budget,
        cache,
        judge_base_url=args.judge_base_url,
        judge_api_key=args.judge_api_key,
        embed_base_url=args.embed_base_url,
        embed_model=args.embed_model,
        stream=not args.no_stream,
    )
    metrics = build_metrics(metric_names, llm, embeddings)

    print(f"[Ragas] judge: {judge}")
    if args.judge_base_url:
        print("[Ragas] judging off Workers AI: the neuron budget now covers only "
              "the agent half and the embeddings")
    if (
        not args.judge_base_url
        and not os.environ.get("OPENAI_API_KEY")
        and args.judge_model not in JSON_MODE_MODELS
    ):
        print(f"[Warn] {args.judge_model} is not on Cloudflare's JSON-mode list. "
              "The schema will only be a prompt instruction, so expect parse "
              "retries and metric errors.", file=sys.stderr)
        print(f"       JSON-mode judges: {', '.join(sorted(JSON_MODE_MODELS))}",
              file=sys.stderr)
    print(f"[Ragas] metrics: {', '.join(metric_names)}")
    if budget.limit:
        print(f"[Ragas] neuron budget: {budget.limit:.0f} "
              f"(free daily allocation is {FREE_DAILY_NEURONS}, resets 00:00 UTC)")
    if cache.dir:
        print(f"[Ragas] judge cache: {cache.dir} "
              f"({len(list(cache.dir.glob('*.json')))} entries)")
    if args.probe_judge or args.judge_base_url:
        if not await probe_judge(llm, judge):
            return 2
        if args.probe_judge:
            return 0
        print()
    print(f"[Ragas] running {len(cases)} cases end-to-end against {args.worker_url}")
    print()

    agent: dict | None = None
    if args.agent_base_url:
        agent = {
            "agentBaseUrl": args.agent_base_url,
            "agentModel": args.agent_model or "qwen2.5:32b",
        }
        if args.agent_api_key:
            agent["agentApiKey"] = args.agent_api_key
        # Someone else's endpoint, so its tokens are not neurons.
        budget.free_models.add(agent["agentModel"])
        print(f"[Ragas] AGENT MODEL SUBSTITUTED: the planner and narrator will run on "
              f"{agent['agentModel']} via {args.agent_base_url},")
        print("        not on Workers AI. This measures the pipeline on that model, "
              "not the one the Worker ships with.")
        print()

    samples: list[dict] = []
    run_failures: list[tuple[str, str]] = []
    for i, c in enumerate(cases, 1):
        print(f"[{i}/{len(cases)}] {c['id']}: {c['question']}")
        res = run_case_cached(args.worker_url, c["id"], run_store, args.reuse_runs, agent)
        if res.get("_fromCache"):
            print("        (reused a recorded run; no model calls)")
        else:
            # The planner and narrator spend neurons inside the Worker. Charging
            # them here is what makes the budget cover the whole run rather than
            # just the judging.
            for model, u in (res.get("aiUsage") or {}).items():
                budget.record(model, u.get("promptTokens", 0), u.get("completionTokens", 0))
        got = res.get("contextSchema")
        if res.get("ok") and got is not None and got != CONTEXT_SCHEMA:
            sys.exit(
                f"[Error] the Worker reports context schema {got}, this runner expects "
                f"{CONTEXT_SCHEMA}. One of the two is stale - restart the Worker, or "
                "align CONTEXT_SCHEMA with EVAL_CONTEXT_SCHEMA in src/evals/route.ts. "
                "Scoring across a mismatch would compare different inputs."
            )
        if not res.get("ok"):
            msg = res.get("error", "unknown error")
            print(f"        -> case did not run: {msg}")
            run_failures.append((c["id"], msg))
            continue
        samples.append(to_sample(c, res))

    if not samples:
        print("\n[Error] no case ran successfully; there is nothing to grade.", file=sys.stderr)
        return 2

    # What the scoring pass is about to cost, before it costs it. On a free
    # account this is the difference between a finished run and a 4006 at case 20.
    agent_neurons = budget.spent
    calls = projected_calls(samples, metric_names)
    rate_in, rate_out = NEURON_RATES.get(args.judge_model, (26_668, 204_805))
    est = calls * ((2000 / 1e6) * rate_in + (300 / 1e6) * rate_out)
    print(f"[Plan] agent half spent {agent_neurons:,.0f} neurons so far")
    print(f"[Plan] {calls} judge calls for {len(samples)} cases x "
          f"{len(metric_names)} metrics")
    print(f"[Plan] rough estimate {est:,.0f} neurons "
          f"({est / FREE_DAILY_NEURONS:.1f}x the {FREE_DAILY_NEURONS}/day free "
          f"allocation, about ${est * NEURON_USD:.2f} if billed)")
    if est > FREE_DAILY_NEURONS and budget.limit:
        print("[Plan] this will not finish in one day on the free allocation. "
              "It will stop at the budget and record the rest as not attempted;")
        print("       re-run with --reuse-runs after 00:00 UTC to continue for "
              "free, or drop metrics with --metrics.")
    if args.dry_run:
        print()
        print("[Plan] --dry-run: stopping before any judge call.")
        return 0
    print()

    skipped = await score_all(samples, metrics, args.concurrency, budget)
    summary = aggregate(samples, metric_names)

    print_report(samples, summary, judge)
    print_cost(budget, samples, metric_names, agent_neurons)
    if skipped:
        # The cause is whichever stop fired; saying "the neuron budget" when the
        # tunnel died sends the reader to the wrong problem.
        print(f"Not attempted ({len(skipped)} case/metric pairs) - the run stopped "
              "before these ran:")
        for cid, name in skipped[:10]:
            print(f"  {cid:<36} {name}")
        if len(skipped) > 10:
            print(f"  ... and {len(skipped) - 10} more")
        reason = getattr(score_all, "endpoint_down_reason", None) or budget.stop_reason
        if reason:
            print(f"  Why: {reason}")
        print("  Re-run with --reuse-runs to pick up where this left off; cached "
              "judge replies and recorded agent runs cost no neurons.")
        print()
    if run_failures:
        print(f"Cases that never ran ({len(run_failures)}):")
        for cid, msg in run_failures:
            print(f"  {cid}: {msg[:80]}")
        print()

    if args.report:
        save_reports(samples, summary, judge, Path(args.out), budget.summary())
    if not args.no_langfuse:
        sync_to_langfuse(samples, judge)

    # Order matters. When the budget stopped the run, a metric with no score is
    # expected and the right answer is "incomplete" (3), not "broken" (1). Only
    # once nothing was skipped does an empty metric mean it silently did not run,
    # which is the failure this suite exists to catch.
    if skipped:
        print(f"[INCOMPLETE] {len(skipped)} case/metric pairs were not attempted; "
              f"spent {budget.spent:.0f} neurons", file=sys.stderr)
        return 3

    dead = [n for n, s in summary.items() if s["applicable"] > 0 and s["scored"] == 0]
    if dead:
        print(f"[FAIL] no usable score from: {', '.join(dead)}", file=sys.stderr)
        print("       The metric did not run. Check the judge endpoint before trusting "
              "any number above.", file=sys.stderr)
        return 1

    total_calls = sum(len(s["scores"]) + len(s["errors"]) for s in samples)
    total_errors = sum(len(s["errors"]) for s in samples)
    if total_calls and total_errors / total_calls > args.max_error_rate:
        print(f"[FAIL] {total_errors}/{total_calls} metric calls errored, above the "
              f"{args.max_error_rate:.0%} threshold", file=sys.stderr)
        return 1
    if run_failures:
        return 1
    return 0


def main() -> None:
    p = argparse.ArgumentParser(description="Ragas evaluation for the LeadPulse analyst pipeline")
    p.add_argument("--worker-url", default=WORKER_URL)
    p.add_argument("--limit", type=int, default=None, help="only the first N golden cases")
    p.add_argument(
        "--metrics", default="all",
        help="'all' (every metric), 'core' (the informative subset: "
             + ", ".join(CORE_METRICS)
             + "), or a comma-separated subset of: "
             + ", ".join(DEFAULT_METRICS),
    )
    p.add_argument(
        "--judge-model", default=JUDGE_MODEL,
        help="judge model id; a Workers AI id by default, or whatever the endpoint "
             "given to --judge-base-url calls it (e.g. qwen2.5:32b for Ollama)",
    )
    p.add_argument(
        "--judge-base-url", default=os.environ.get("RAGAS_JUDGE_BASE_URL"),
        help="OpenAI-compatible endpoint to judge with instead of Workers AI - a "
             "self-hosted Ollama/vLLM/llama.cpp server or another free tier. "
             "'/v1' is appended if missing. Costs no neurons.",
    )
    p.add_argument(
        "--judge-api-key", default=os.environ.get("RAGAS_JUDGE_API_KEY"),
        help="bearer token for --judge-base-url; Ollama needs none",
    )
    p.add_argument(
        "--embed-base-url", default=os.environ.get("RAGAS_EMBED_BASE_URL"),
        help="OpenAI-compatible embeddings endpoint; defaults to the Worker, which "
             "is usually right - embeddings are a rounding error on bge-m3",
    )
    p.add_argument("--embed-model", default=None, help="override the embedding model id")
    p.add_argument(
        "--no-stream", action="store_true", default=False,
        help="disable streaming for an external judge; streaming is what keeps a "
             "slow model from tripping a proxy's time-to-first-byte timeout",
    )
    p.add_argument(
        "--agent-base-url", default=os.environ.get("RAGAS_AGENT_BASE_URL"),
        help="run the PLANNER AND NARRATOR on this OpenAI-compatible endpoint instead "
             "of Workers AI. This changes the system under test - the report then "
             "describes the pipeline on that model, not the shipped one. Use it to "
             "compare planners, or when the Workers AI allocation is gone.",
    )
    p.add_argument("--agent-model", default=None, help="model id for --agent-base-url")
    p.add_argument("--agent-api-key", default=os.environ.get("RAGAS_AGENT_API_KEY"))
    p.add_argument(
        "--probe-judge", action="store_true", default=False,
        help="send one schema-constrained request, report whether it validated, "
             "and exit; run this first against a new endpoint",
    )
    p.add_argument("--concurrency", type=int, default=4, help="parallel metric evaluations")
    p.add_argument("--max-error-rate", type=float, default=0.1,
                   help="fail the run above this share of errored metric calls")
    p.add_argument("--out", default="evals/reports", help="report directory")
    p.add_argument(
        "--neuron-budget", type=float, default=9500,
        help="stop before spending more than this many Workers AI neurons "
             "(default 9500, just under the 10,000/day free allocation; 0 disables)",
    )
    p.add_argument("--judge-cache", default="evals/.judge-cache",
                   help="directory of cached judge replies; a hit costs no neurons")
    p.add_argument("--no-judge-cache", action="store_true", default=False)
    p.add_argument("--run-cache", default="evals/.runs",
                   help="directory of recorded end-to-end agent runs")
    p.add_argument("--no-run-cache", action="store_true", default=False)
    p.add_argument(
        "--reuse-runs", action="store_true", default=False,
        help="score the recorded agent runs instead of re-running the agent; "
             "saves two model calls per case and grades the same text as last time",
    )
    p.add_argument(
        "--dry-run", action="store_true", default=False,
        help="run the agent half, print the projected judge cost, and stop before "
             "spending anything on judging",
    )
    p.add_argument("--no-report", dest="report", action="store_false", default=True)
    p.add_argument("--no-langfuse", action="store_true", default=False)
    args = p.parse_args()
    sys.exit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
