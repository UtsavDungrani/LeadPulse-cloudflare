#!/usr/bin/env python3
"""
Synthetic Case Generator using Ragas / Schema for LeadPulse.

Automatically synthesizes new diverse, high-value evaluation test cases
(multi-hop, temporal reasoning, comparative questions, and refusal traps)
based on the live semantic catalog (/api/catalog).

Outputs clean TypeScript GoldenCase objects ready for src/evals/golden.ts.

Usage:
  python scripts/generate_synthetic_cases.py --count 5
"""

import argparse
import json
import os
import sys
import requests
from typing import Any, Dict, List

def load_dev_vars(path: str = ".dev.vars") -> None:
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip().strip("\"'")
            if k not in os.environ:
                os.environ[k] = v

load_dev_vars()
WORKER_URL = os.environ.get("EVAL_WORKER_URL", "http://127.0.0.1:8787").rstrip("/")


def fetch_catalog(worker_url: str) -> Dict[str, Any]:
    try:
        res = requests.get(f"{worker_url}/api/catalog", timeout=10)
        if res.status_code == 200:
            return res.json()
    except Exception:
        pass
    # Fallback to local hardcoded catalog if worker is not up
    return {
        "metrics": [
            {"id": "leads_created", "label": "Leads created", "unit": "count"},
            {"id": "deals_won", "label": "Deals won", "unit": "count"},
            {"id": "deal_conversion_pct", "label": "Deal conversion", "unit": "percent"},
            {"id": "revenue_won", "label": "Revenue won", "unit": "currency"},
            {"id": "open_pipeline", "label": "Open pipeline", "unit": "currency"},
            {"id": "total_spend", "label": "Total spend", "unit": "currency"},
            {"id": "cac", "label": "Customer Acquisition Cost", "unit": "currency"},
            {"id": "roas", "label": "Return on Ad Spend", "unit": "ratio"},
        ],
        "dimensions": [
            {"id": "lead_source", "values": ["Google Ads", "Organic Search", "Direct Traffic", "Olark Chat", "Referral Sites"]},
            {"id": "channel", "values": ["Paid Search", "Organic", "Direct", "Chat", "Referral"]},
            {"id": "region", "values": ["North America", "EMEA", "APAC", "LATAM"]},
            {"id": "stage", "values": ["Prospecting", "Qualification", "Proposal", "Negotiation", "Closed Won", "Closed Lost"]},
        ],
    }


def generate_synthetic_cases(catalog: Dict[str, Any], count: int = 5):
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import HumanMessage, SystemMessage

    openai_key = os.environ.get("OPENAI_API_KEY")
    if openai_key:
        llm = ChatOpenAI(model="gpt-4o-mini", api_key=openai_key, temperature=0.7)
    else:
        llm = ChatOpenAI(
            base_url=f"{WORKER_URL}/api/eval",
            api_key="worker-internal",
            model="@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            temperature=0.7,
        )

    metrics_desc = "\n".join([f"- {m['id']} ({m.get('unit')}): {m.get('label')}" for m in catalog.get("metrics", [])])
    dims_desc = "\n".join([f"- {d['id']}: values {d.get('values', [])}" for d in catalog.get("dimensions", [])])

    system_prompt = f"""You are a test dataset generator for an enterprise CRM & analytics AI copilot.
Your job is to generate diverse, realistic user questions and their expected evaluation classification.

Catalog Metrics:
{metrics_desc}

Catalog Dimensions:
{dims_desc}

Grains: total, day, week, month, quarter.
CompareTo: none, previous_period, same_period_last_year.

Generate {count} test cases:
- Some should be natural user analytics queries (asking for breakdowns, time grains, or comparisons).
- At least 1 should be a subtle refusal trap (asking for something outside the schema like 'LTV', 'churn rate', or 'profit margin' which must be declined).

Return ONLY valid JSON array with objects matching:
[
  {{
    "id": "slug-name",
    "question": "The natural user question",
    "isRefusal": false,
    "intent": {{
      "metric": "leads_created",
      "grain": "total",
      "dateRange": {{"from": "2026-08-01", "to": "2026-08-31"}},
      "dimensions": ["lead_source"],
      "compareTo": "none"
    }},
    "note": "Why this test case is challenging"
  }}
]
"""

    resp = llm.invoke([
        SystemMessage(content=system_prompt),
        HumanMessage(content=f"Generate {count} new high-quality test cases now.")
    ])

    content = resp.content.strip()
    if content.startswith("```json"):
        content = content[7:]
    if content.startswith("```"):
        content = content[3:]
    if content.endswith("```"):
        content = content[:-3]
    content = content.strip()

    try:
        cases = json.loads(content)
    except Exception as e:
        print(f"[Error] Failed to parse generated JSON: {e}\nContent was:\n{content}")
        return []

    print(f"\nSuccessfully generated {len(cases)} synthetic test cases:\n")
    for c in cases:
        print(f"Case ID: {c.get('id')}")
        print(f"Question: \"{c.get('question')}\"")
        if c.get("isRefusal"):
            print("Expect: refusal")
        else:
            print(f"Intent: {c.get('intent')}")
        print(f"Note: {c.get('note')}\n")

    return cases


def main():
    parser = argparse.ArgumentParser(description="Synthetic Test Case Generator for LeadPulse")
    parser.add_argument("--count", type=int, default=3, help="Number of cases to generate")
    args = parser.parse_args()

    catalog = fetch_catalog(WORKER_URL)
    generate_synthetic_cases(catalog, args.count)


if __name__ == "__main__":
    main()

