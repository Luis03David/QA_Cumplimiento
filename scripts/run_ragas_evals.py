#!/usr/bin/env python3
"""RAG eval runner with deterministic gates and optional RAGAS execution."""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jsonschema import validate

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASES = ROOT / "tests" / "ragas" / "fixtures" / "ragas_eval_cases.json"
RESULTS_DIR = ROOT / "resultados"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def tokens(value: str) -> set[str]:
    return {item for item in re.findall(r"[a-z0-9_/-]{3,}", str(value).lower())}


def score_status(score: float, threshold: float) -> str:
    return "pass" if score >= threshold else "fail"


def deterministic_scores(case: dict[str, Any]) -> dict[str, float]:
    answer = str(case.get("answer") or "")
    question = str(case.get("question") or "")
    contexts = [str(item) for item in case.get("contexts") or []]
    context_text = "\n".join(contexts)
    retrieved = list(case.get("retrieved_context_ids") or [])
    relevant = set(case.get("relevant_context_ids") or [])
    required_terms = [str(item).lower() for item in case.get("required_answer_terms") or []]

    relevant_retrieved = [item for item in retrieved if item in relevant]
    context_precision = len(relevant_retrieved) / len(retrieved) if retrieved else 0.0
    context_recall = len(set(relevant_retrieved)) / len(relevant) if relevant else 1.0

    answer_l = answer.lower()
    context_l = context_text.lower()
    supported_terms = [term for term in required_terms if term in answer_l and term in context_l]
    faithfulness = len(supported_terms) / len(required_terms) if required_terms else 1.0

    q_tokens = tokens(question)
    a_tokens = tokens(answer)
    answer_relevancy = len(q_tokens & a_tokens) / max(1, min(len(q_tokens), 8))
    if required_terms and all(term in answer_l for term in required_terms):
        answer_relevancy = max(answer_relevancy, 0.85)

    return {
        "faithfulness": round(min(faithfulness, 1.0), 4),
        "context_precision": round(context_precision, 4),
        "context_recall": round(context_recall, 4),
        "answer_relevancy": round(min(answer_relevancy, 1.0), 4),
    }


def build_checks(cases: list[dict[str, Any]], threshold: float) -> list[dict[str, Any]]:
    checks = []
    for case in cases:
        scores = deterministic_scores(case)
        for metric in case.get("metrics") or scores.keys():
            score = scores.get(metric)
            if score is None:
                continue
            checks.append(
                {
                    "name": f"{case['id']} {metric}",
                    "status": score_status(score, threshold),
                    "message": f"{metric}={score}; threshold={threshold}",
                    "details": {
                        "case_id": case["id"],
                        "eval_theme": "rag",
                        "metric": metric,
                        "score": score,
                        "threshold": threshold,
                    },
                }
            )
    return checks


def summarize_metrics(checks: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for check in checks:
        details = check.get("details") or {}
        metric = details.get("metric")
        if not metric:
            continue
        bucket = buckets.setdefault(
            metric,
            {"metric": metric, "total": 0, "pass": 0, "fail": 0, "skipped": 0, "_scores": [], "_latencies": []},
        )
        status = check.get("status") if check.get("status") in {"pass", "fail", "skipped"} else "fail"
        bucket["total"] += 1
        bucket[status] += 1
        score = details.get("score")
        if isinstance(score, (int, float)) and math.isfinite(score):
            bucket["_scores"].append(float(score))
        latency = details.get("eval_latency_ms")
        if isinstance(latency, (int, float)):
            bucket["_latencies"].append(float(latency))

    summary = {}
    for metric, bucket in sorted(buckets.items()):
        scores = bucket.pop("_scores")
        latencies = bucket.pop("_latencies")
        total = bucket["total"]
        bucket["pass_rate"] = round(bucket["pass"] / total, 4) if total else 0
        bucket["avg_score"] = round(sum(scores) / len(scores), 4) if scores else None
        bucket["min_score"] = round(min(scores), 4) if scores else None
        bucket["max_score"] = round(max(scores), 4) if scores else None
        bucket["avg_latency_ms"] = round(sum(latencies) / len(latencies), 2) if latencies else None
        summary[metric] = bucket
    return summary


def ragas_import_check() -> dict[str, Any]:
    try:
        import ragas  # type: ignore

        return {
            "name": "ragas-installed",
            "status": "pass",
            "message": f"RAGAS instalado: {getattr(ragas, '__version__', 'unknown')}",
            "details": {"metric": "runner"},
        }
    except Exception as exc:
        return {
            "name": "ragas-installed",
            "status": "skipped",
            "message": f"RAGAS no instalado: {exc}",
            "details": {"metric": "runner", "install": "python3 -m pip install -r requirements-ragas-evals.txt"},
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run deterministic RAGAS-style RAG evals.")
    parser.add_argument("--cases", default=str(DEFAULT_CASES))
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--use-ragas", action="store_true", help="Check RAGAS availability and reserve room for provider-backed metrics.")
    args = parser.parse_args()

    started_at = utc_now()
    run_ts = timestamp()
    cases_path = Path(args.cases)
    cases = json.loads(cases_path.read_text(encoding="utf-8"))
    checks = build_checks(cases, args.threshold)
    if args.use_ragas:
        checks.append(ragas_import_check())

    status = "fail" if any(check["status"] == "fail" for check in checks) else "pass"
    result = {
        "schema_version": "1.0",
        "run_id": f"ragas-evals-{run_ts}",
        "tool": "ragas-evals",
        "category": "compliance",
        "status": status,
        "started_at": started_at,
        "finished_at": utc_now(),
        "summary": "RAGAS/RAG evals completados." if status == "pass" else "RAGAS/RAG evals encontraron fallas.",
        "checks": checks,
        "metrics_summary": summarize_metrics(checks),
        "artifacts": [str(cases_path.relative_to(ROOT) if cases_path.is_relative_to(ROOT) else cases_path)],
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    output = RESULTS_DIR / f"ragas-evals-{run_ts}.json"
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    validate(result, json.loads((ROOT / "config" / "result.schema.json").read_text(encoding="utf-8")))
    print(f"wrote {output}")
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
