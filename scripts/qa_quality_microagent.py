#!/usr/bin/env python3
"""Microagente local de QA Calidad.

Orquesta gates existentes del repo y deja evidencia compatible con
config/result.schema.json. No imprime secretos.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jsonschema import ValidationError, validate

ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = ROOT / "resultados"
SCHEMA_PATH = ROOT / "config" / "result.schema.json"
AUTH_PATH = ROOT / ".auth" / "aitops.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def env_status(*keys: str) -> dict[str, str]:
    return {key: ("set" if os.getenv(key, "").strip() else "empty") for key in keys}


def run_command(args: list[str], *, allow_fail: bool = False) -> dict[str, Any]:
    proc = subprocess.run(
        args,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=os.environ.copy(),
        check=False,
    )
    if proc.returncode != 0 and not allow_fail:
        status = "fail"
    else:
        status = "pass" if proc.returncode == 0 else "fail"
    return {
        "args": args,
        "exit_code": proc.returncode,
        "status": status,
        "stdout_tail": tail(proc.stdout),
        "stderr_tail": tail(proc.stderr),
    }


def tail(value: str, limit: int = 3000) -> str:
    value = value or ""
    return value[-limit:]


def latest_result(prefix: str) -> Path | None:
    candidates = sorted(
        path
        for path in RESULTS_DIR.glob(f"{prefix}-*.json")
        if not path.name.endswith(".raw.json")
    )
    return candidates[-1] if candidates else None


def latest_chat_consistency_result() -> Path | None:
    candidates = sorted(
        path
        for path in RESULTS_DIR.glob("chat-consistency-*.json")
        if not path.name.endswith(".raw.json")
    )
    if not candidates:
        return None
    reviewed = [path for path in candidates if "-reviewed" in path.name]
    return reviewed[-1] if reviewed else candidates[-1]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def schema_check(path: Path, schema: dict[str, Any]) -> dict[str, Any]:
    try:
        data = read_json(path)
        validate(data, schema)
        status = "pass"
        message = "Resultado compatible con config/result.schema.json."
    except (json.JSONDecodeError, OSError, ValidationError) as exc:
        data = {}
        status = "fail"
        message = str(exc)
    return {
        "name": f"schema {path.name}",
        "status": status,
        "message": message,
        "details": {
            "path": str(path.relative_to(ROOT)),
            "result_status": data.get("status") if isinstance(data, dict) else None,
            "tool": data.get("tool") if isinstance(data, dict) else None,
        },
    }


def metric_name_for_check(check: dict[str, Any]) -> str:
    details = check.get("details") or {}
    if details.get("metric"):
        return str(details["metric"])
    name = str(check.get("name") or "runner")
    if name.startswith("schema "):
        return "schema"
    if name.endswith("-run"):
        return "runner"
    return name


def summarize_metrics(checks: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for check in checks:
        metric = metric_name_for_check(check)
        bucket = buckets.setdefault(
            metric,
            {"metric": metric, "total": 0, "pass": 0, "fail": 0, "skipped": 0, "_scores": [], "_latencies": []},
        )
        status = check.get("status") if check.get("status") in {"pass", "fail", "skipped"} else "fail"
        bucket["total"] += 1
        bucket[status] += 1
        details = check.get("details") or {}
        score = details.get("score")
        if isinstance(score, (int, float)):
            bucket["_scores"].append(float(score))
        latency = details.get("eval_latency_ms")
        if isinstance(latency, (int, float)):
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


def auth_check() -> dict[str, Any]:
    if not AUTH_PATH.exists():
        return {
            "name": "aitops-session",
            "status": "skipped",
            "message": "No existe .auth/aitops.json. Se puede capturar con npm run e2e:auth.",
            "details": {"auth_file": "missing"},
        }
    try:
        data = read_json(AUTH_PATH)
        origins = data.get("origins") or []
        has_token = any(
            item.get("name") == "access_token"
            for origin in origins
            for item in origin.get("localStorage", [])
        )
    except Exception as exc:
        return {
            "name": "aitops-session",
            "status": "fail",
            "message": f"No se pudo leer .auth/aitops.json: {exc}",
            "details": {"auth_file": "invalid"},
        }
    return {
        "name": "aitops-session",
        "status": "pass" if has_token else "fail",
        "message": "Sesion local disponible." if has_token else "Sesion sin access_token.",
        "details": {
            "auth_file": "present",
            "origins": [origin.get("origin") for origin in origins],
            "has_access_token": has_token,
        },
    }


def deepeval_check() -> dict[str, Any]:
    try:
        import deepeval  # type: ignore

        version = getattr(deepeval, "__version__", "unknown")
        return {
            "name": "deepeval-installed",
            "status": "pass",
            "message": f"DeepEval instalado: {version}",
            "details": {"version": version},
        }
    except Exception as exc:
        return {
            "name": "deepeval-installed",
            "status": "skipped",
            "message": f"DeepEval no instalado: {exc}",
            "details": {"install": "python3 -m pip install -r requirements-agentic-evals.txt"},
        }


def capture_session() -> dict[str, Any]:
    result = run_command(["npm", "run", "e2e:auth"], allow_fail=True)
    return {
        "name": "capture-session",
        "status": result["status"],
        "message": "Captura de sesion ejecutada." if result["status"] == "pass" else "Captura de sesion fallo.",
        "details": result,
    }


def run_agentic(use_deepeval: bool, selected_cases: list[str]) -> tuple[list[dict[str, Any]], list[str]]:
    args = [sys.executable, "scripts/run_agentic_evals.py"]
    if use_deepeval:
        args.append("--use-deepeval")
    else:
        args.append("--rules-only")
    for case_id in selected_cases:
        args.extend(["--case", case_id])

    before = set(RESULTS_DIR.glob("agentic-evals-*.json"))
    command_result = run_command(args, allow_fail=True)
    after = set(RESULTS_DIR.glob("agentic-evals-*.json"))
    created = sorted(after - before)
    if not created:
        latest = latest_result("agentic-evals")
        created = [latest] if latest else []

    checks = [
        {
            "name": "agentic-evals-run",
            "status": command_result["status"],
            "message": "Agentic evals ejecutados." if command_result["status"] == "pass" else "Agentic evals reportaron fallas.",
            "details": command_result,
        }
    ]
    artifacts = [str(path.relative_to(ROOT)) for path in created if path]
    return checks, artifacts


def run_repo_gate(name: str, args: list[str], prefix: str) -> tuple[list[dict[str, Any]], list[str]]:
    before = set(RESULTS_DIR.glob(f"{prefix}-*.json"))
    command_result = run_command(args, allow_fail=True)
    after = set(RESULTS_DIR.glob(f"{prefix}-*.json"))
    created = sorted(after - before)
    if not created:
        latest = latest_result(prefix)
        created = [latest] if latest else []
    checks = [
        {
            "name": f"{name}-run",
            "status": command_result["status"],
            "message": f"{name} ejecutado." if command_result["status"] == "pass" else f"{name} reporto fallas.",
            "details": command_result,
        }
    ]
    artifacts = [str(path.relative_to(ROOT)) for path in created if path]
    return checks, artifacts


def summarize_latest_chat_consistency() -> dict[str, Any]:
    latest = latest_chat_consistency_result()
    if not latest:
        return {
            "name": "chat-consistency-history",
            "status": "skipped",
            "message": "No hay resultados chat-consistency disponibles.",
            "details": {},
        }
    data = read_json(latest)
    checks = data.get("checks") or []
    failed = [check for check in checks if check.get("status") == "fail"]
    return {
        "name": "chat-consistency-history",
        "status": "pass" if data.get("status") == "pass" else "fail",
        "message": f"Ultimo chat-consistency: {latest.name}, status={data.get('status')}, fallas={len(failed)}.",
        "details": {
            "path": str(latest.relative_to(ROOT)),
            "result_status": data.get("status"),
            "checks": len(checks),
            "failed_checks": len(failed),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Microagente QA Calidad.")
    parser.add_argument("--capture-session", action="store_true", help="Captura sesion Cloudflare/app antes de correr gates.")
    parser.add_argument("--use-deepeval", action="store_true", help="Activa DeepEval LLM-as-a-judge en CP-12.")
    parser.add_argument("--case", action="append", default=[], help="Caso CP-12 especifico. Puede repetirse.")
    parser.add_argument("--skip-agentic", action="store_true", help="Solo preflight/sesion/schema historico; no ejecuta CP-12.")
    parser.add_argument("--skip-ragas", action="store_true", help="No ejecuta RAGAS/RAG evals.")
    parser.add_argument("--skip-agent-workflows", action="store_true", help="No ejecuta agent workflow evals.")
    parser.add_argument("--skip-promptfoo", action="store_true", help="No genera/ejecuta Promptfoo.")
    args = parser.parse_args()

    load_dotenv(ROOT / ".env.local")
    load_dotenv(ROOT / ".env")

    started_at = utc_now()
    run_id = f"qa-quality-agent-{timestamp()}"
    checks: list[dict[str, Any]] = []
    artifacts: list[str] = []

    checks.append(
        {
            "name": "environment-preflight",
            "status": "pass",
            "message": "Variables requeridas inspeccionadas sin exponer secretos.",
            "details": {
                "env": env_status(
                    "AITOPS_BASE_URL",
                    "AITOPS_USER_EMAIL",
                    "ICS_LLM_MODEL_NAME",
                    "ICS_LLM_RUNPOD_POD_NAME",
                    "RUNPOD_API_KEY",
                    "ICS_EMBEDDINGS_RUNPOD_POD_NAME",
                )
            },
        }
    )
    checks.append(auth_check())
    checks.append(deepeval_check())

    if args.capture_session:
        checks.append(capture_session())
        checks.append(auth_check())

    if not args.skip_agentic:
        agentic_checks, agentic_artifacts = run_agentic(args.use_deepeval, args.case)
        checks.extend(agentic_checks)
        artifacts.extend(agentic_artifacts)
    if not args.skip_ragas:
        ragas_checks, ragas_artifacts = run_repo_gate("ragas-evals", [sys.executable, "scripts/run_ragas_evals.py"], "ragas-evals")
        checks.extend(ragas_checks)
        artifacts.extend(ragas_artifacts)
    if not args.skip_agent_workflows:
        workflow_checks, workflow_artifacts = run_repo_gate(
            "agent-workflow-evals",
            [sys.executable, "scripts/run_agent_workflow_evals.py"],
            "agent-workflow-evals",
        )
        checks.extend(workflow_checks)
        artifacts.extend(workflow_artifacts)
    if not args.skip_promptfoo:
        promptfoo_checks, promptfoo_artifacts = run_repo_gate(
            "promptfoo-evals",
            [sys.executable, "scripts/run_promptfoo_eval.py"],
            "promptfoo-evals",
        )
        checks.extend(promptfoo_checks)
        artifacts.extend(promptfoo_artifacts)

    checks.append(summarize_latest_chat_consistency())

    schema = read_json(SCHEMA_PATH)
    for artifact in list(artifacts):
        path = ROOT / artifact
        if path.exists() and path.name.endswith(".json"):
            checks.append(schema_check(path, schema))

    finished_at = utc_now()
    blocking_statuses = [check["status"] for check in checks if check["status"] != "skipped"]
    status = "fail" if any(item == "fail" for item in blocking_statuses) else "pass"
    result = {
        "schema_version": "1.0",
        "run_id": run_id,
        "tool": "qa-quality-microagent",
        "category": "compliance",
        "status": status,
        "started_at": started_at,
        "finished_at": finished_at,
        "summary": "Microagente QA Calidad completo." if status == "pass" else "Microagente QA Calidad encontro fallas.",
        "checks": checks,
        "metrics_summary": summarize_metrics(checks),
        "artifacts": artifacts,
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    output = RESULTS_DIR / f"{run_id}.json"
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {output}")
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
