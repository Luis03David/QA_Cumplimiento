#!/usr/bin/env python3
"""Generate Promptfoo config and optionally run promptfoo."""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jsonschema import validate

from run_agentic_evals import load_dotenv, normalize_base_url, resolve_runpod_endpoint, first_env

try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    yaml = None

ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = ROOT / "resultados"
CASES = ROOT / "tests" / "agentic" / "fixtures" / "cp12_agentic_eval_cases.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def build_assertions(case: dict[str, Any]) -> list[dict[str, Any]]:
    assertions = []
    rules = case.get("rule_assertions") or {}
    for item in rules.get("must_include") or []:
        assertions.append({"type": "contains", "value": item})
    for item in rules.get("must_not_include") or []:
        assertions.append({"type": "not-contains", "value": item})
    for item in rules.get("must_include_any") or []:
        assertions.append(
            {
                "type": "javascript",
                "value": f"output.toLowerCase().includes({json.dumps(str(item).lower())})",
            }
        )
    if not assertions:
        assertions.append({"type": "javascript", "value": "output.trim().length > 0"})
    return assertions


def write_config(path: Path, config: dict[str, Any]) -> None:
    if yaml is not None:
        path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding="utf-8")
    else:
        path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def generate_config(path: Path) -> dict[str, Any]:
    load_dotenv(ROOT / ".env.local")
    load_dotenv(ROOT / ".env")
    fallback_url = normalize_base_url(first_env("PROMPTFOO_OPENAI_BASE_URL", "ICS_LLM_API_URL", "VLLM_API_BASE"))
    api_base_url = resolve_runpod_endpoint(("ICS_LLM",), fallback_url)
    model = first_env("PROMPTFOO_MODEL", "ICS_LLM_MODEL_NAME", "ETHICS_MODEL_ID", "VLLM_MODEL_ID") or "local-model"
    cases = json.loads(CASES.read_text(encoding="utf-8"))

    config = {
        "description": "QA Cumplimiento CP-12 prompt regression",
        "prompts": ["{{prompt}}"],
        "providers": [
            {
                "id": f"openai:chat:{model}",
                "config": {
                    "apiBaseUrl": api_base_url,
                    "apiKey": "${ICS_LLM_API_KEY}",
                    "temperature": 0,
                    "max_tokens": 512,
                },
            }
        ],
        "tests": [
            {
                "description": case["id"],
                "vars": {"prompt": case["input"]},
                "assert": build_assertions(case),
                "metadata": {
                    "eval_theme": case.get("eval_theme"),
                    "risk_class": case.get("risk_class"),
                    "baseline_id": case.get("baseline_id"),
                },
            }
            for case in cases
        ],
    }
    write_config(path, config)
    return config


def summarize_metrics(checks: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for check in checks:
        metric = str((check.get("details") or {}).get("metric") or "runner")
        bucket = buckets.setdefault(
            metric,
            {"metric": metric, "total": 0, "pass": 0, "fail": 0, "skipped": 0, "_scores": [], "_latencies": []},
        )
        status = check.get("status") if check.get("status") in {"pass", "fail", "skipped"} else "fail"
        bucket["total"] += 1
        bucket[status] += 1
        score = (check.get("details") or {}).get("score")
        if isinstance(score, (int, float)) and math.isfinite(score):
            bucket["_scores"].append(float(score))
        latency = (check.get("details") or {}).get("eval_latency_ms")
        if isinstance(latency, (int, float)) and math.isfinite(latency):
            bucket["_latencies"].append(float(latency))

    summary: dict[str, dict[str, Any]] = {}
    for metric, bucket in sorted(buckets.items()):
        scores = bucket.pop("_scores")
        latencies = bucket.pop("_latencies")
        total = bucket["total"]
        evaluated = bucket["pass"] + bucket["fail"]
        bucket["pass_rate"] = round(bucket["pass"] / evaluated, 4) if evaluated else 0
        bucket["avg_score"] = round(sum(scores) / len(scores), 4) if scores else None
        bucket["min_score"] = round(min(scores), 4) if scores else None
        bucket["max_score"] = round(max(scores), 4) if scores else None
        bucket["avg_latency_ms"] = round(sum(latencies) / len(latencies), 2) if latencies else None
        summary[metric] = bucket
    return summary


def main() -> int:
    started_at = utc_now()
    run_ts = timestamp()
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    config_path = RESULTS_DIR / f"promptfooconfig-{run_ts}.{'yaml' if yaml is not None else 'json'}"
    config = generate_config(config_path)

    checks = [
        {
            "name": "promptfoo-config-generated",
            "status": "pass",
            "message": f"Config Promptfoo generada con {len(config.get('tests') or [])} tests.",
            "details": {"metric": "config", "tests": len(config.get("tests") or [])},
        }
    ]

    promptfoo = shutil.which("promptfoo")
    if not promptfoo:
        checks.append(
            {
                "name": "promptfoo-cli",
                "status": "skipped",
                "message": "Promptfoo CLI no instalado. Instala con npm install -D promptfoo o usa npx promptfoo.",
                "details": {"metric": "runner"},
            }
        )
    else:
        raw_path = RESULTS_DIR / f"promptfoo-{run_ts}.raw.json"
        proc = subprocess.run(
            [promptfoo, "eval", "-c", str(config_path), "--output", str(raw_path)],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env=os.environ.copy(),
        )
        checks.append(
            {
                "name": "promptfoo-eval",
                "status": "pass" if proc.returncode == 0 else "fail",
                "message": "Promptfoo eval completo." if proc.returncode == 0 else "Promptfoo eval fallo.",
                "details": {
                    "metric": "runner",
                    "exit_code": proc.returncode,
                    "stdout_tail": proc.stdout[-2000:],
                    "stderr_tail": proc.stderr[-2000:],
                },
            }
        )

    status = "fail" if any(check["status"] == "fail" for check in checks) else "pass"
    result = {
        "schema_version": "1.0",
        "run_id": f"promptfoo-evals-{run_ts}",
        "tool": "promptfoo-evals",
        "category": "compliance",
        "status": status,
        "started_at": started_at,
        "finished_at": utc_now(),
        "summary": "Promptfoo config/eval preparado." if status == "pass" else "Promptfoo eval encontro fallas.",
        "checks": checks,
        "metrics_summary": summarize_metrics(checks),
        "artifacts": [str(config_path.relative_to(ROOT))],
    }
    output = RESULTS_DIR / f"promptfoo-evals-{run_ts}.json"
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    validate(result, json.loads((ROOT / "config" / "result.schema.json").read_text(encoding="utf-8")))
    print(f"wrote {output}")
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
