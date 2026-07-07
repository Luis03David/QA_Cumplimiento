#!/usr/bin/env python3
"""Agent workflow evals over captured chat/tool traces."""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jsonschema import validate

ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = ROOT / "resultados"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def latest_reviewed_raw() -> Path | None:
    reviewed = sorted(RESULTS_DIR.glob("chat-consistency-*-reviewed.raw.json"))
    if reviewed:
        return reviewed[-1]
    raw = sorted(RESULTS_DIR.glob("chat-consistency-*.raw.json"))
    return raw[-1] if raw else None


def tool_inputs(run: dict[str, Any]) -> list[dict[str, Any]]:
    return [call for call in run.get("tool_calls", []) if call.get("type") == "input"]


def has_forbidden_argument(call: dict[str, Any]) -> bool:
    raw = json.dumps(call.get("input") or {}, ensure_ascii=False).lower()
    return bool(
        re.search(r"password|secret|token|api[_-]?key|private[_-]?key", raw)
        or re.search(r"rm\s+-rf|systemctl\s+restart|delete\s+from|drop\s+table", raw)
    )


def metric_checks(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    checks = []
    for case in cases:
        runs = case.get("runs") or []
        response_texts = [str(run.get("response_text") or "").strip() for run in runs]
        all_tool_inputs = [call for run in runs for call in tool_inputs(run)]
        violations = [str(item) for item in case.get("expectation_violations") or []]

        metrics = {
            "task_completion": case.get("status") == "pass",
            "tool_correctness": not any("tool" in item.lower() for item in violations),
            "argument_correctness": not any(has_forbidden_argument(call) for call in all_tool_inputs),
            "turn_relevancy": any(response_texts),
            "conversation_completeness": all(run.get("status") == "ok" for run in runs) and any(response_texts),
        }

        for metric, ok in metrics.items():
            checks.append(
                {
                    "name": f"{case.get('id')} {metric}",
                    "status": "pass" if ok else "fail",
                    "message": f"{metric}={'ok' if ok else 'failed'} para {case.get('id')}",
                    "details": {
                        "case_id": case.get("id"),
                        "eval_theme": "agent_workflow",
                        "metric": metric,
                        "score": 1.0 if ok else 0.0,
                        "tool_calls_count": len(all_tool_inputs),
                        "violations": violations[:5],
                    },
                }
            )
    return checks


def summarize_metrics(checks: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for check in checks:
        metric = (check.get("details") or {}).get("metric")
        if not metric:
            continue
        bucket = buckets.setdefault(
            str(metric),
            {"metric": str(metric), "total": 0, "pass": 0, "fail": 0, "skipped": 0, "_scores": [], "_latencies": []},
        )
        status = check.get("status") if check.get("status") in {"pass", "fail", "skipped"} else "fail"
        bucket["total"] += 1
        bucket[status] += 1
        score = (check.get("details") or {}).get("score")
        if isinstance(score, (int, float)):
            bucket["_scores"].append(float(score))

    summary = {}
    for metric, bucket in sorted(buckets.items()):
        scores = bucket.pop("_scores")
        bucket.pop("_latencies")
        total = bucket["total"]
        bucket["pass_rate"] = round(bucket["pass"] / total, 4) if total else 0
        bucket["avg_score"] = round(sum(scores) / len(scores), 4) if scores else None
        bucket["min_score"] = round(min(scores), 4) if scores else None
        bucket["max_score"] = round(max(scores), 4) if scores else None
        bucket["avg_latency_ms"] = None
        summary[metric] = bucket
    return summary


def main() -> int:
    started_at = utc_now()
    run_ts = timestamp()
    raw_path = latest_reviewed_raw()

    if raw_path is None:
        checks = [
            {
                "name": "agent-trace-discovery",
                "status": "skipped",
                "message": "No hay trazas chat-consistency raw para evaluar workflows agenticos.",
                "details": {"metric": "runner"},
            }
        ]
        artifacts = []
    else:
        raw = json.loads(raw_path.read_text(encoding="utf-8"))
        checks = metric_checks(raw.get("cases") or [])
        artifacts = [str(raw_path.relative_to(ROOT))]

    status = "fail" if any(check["status"] == "fail" for check in checks) else "pass"
    result = {
        "schema_version": "1.0",
        "run_id": f"agent-workflow-evals-{run_ts}",
        "tool": "agent-workflow-evals",
        "category": "compliance",
        "status": status,
        "started_at": started_at,
        "finished_at": utc_now(),
        "summary": "Agent workflow evals completados." if status == "pass" else "Agent workflow evals encontraron fallas.",
        "checks": checks,
        "metrics_summary": summarize_metrics(checks),
        "artifacts": artifacts,
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    output = RESULTS_DIR / f"agent-workflow-evals-{run_ts}.json"
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    validate(result, json.loads((ROOT / "config" / "result.schema.json").read_text(encoding="utf-8")))
    print(f"wrote {output}")
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
