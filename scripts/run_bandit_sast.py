#!/usr/bin/env python3
# SAST (analisis estatico de seguridad) para el codigo Python del repo usando
# Bandit. No ejecuta la app: lee el codigo fuente y busca patrones peligrosos
# (subprocess con shell, secretos en duro, cripto debil, eval, etc.) y escribe
# evidencia en el formato estandar de resultados (category=sast) para que el
# dashboard/seguridad la muestre junto con dependency y secret.
#
# Gate de severidad: hallazgos HIGH y MEDIUM => fail; LOW => se reporta pero no
# bloquea. Los test-ids aceptados como riesgo documentado se leen de
# config/bandit-ignore.json (ver docs/accepted-risks.md).
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "resultados"
IGNORE_CONFIG = ROOT / "config" / "bandit-ignore.json"

# Directorios que no son codigo propio del repo: no tiene sentido analizarlos.
EXCLUDED_DIRS = [".git", ".venv", "venv", "node_modules", "resultados", ".next", "__pycache__", ".deepeval"]

# Severidades que bloquean (status fail). LOW se reporta como pass con nota.
BLOCKING_SEVERITIES = {"HIGH", "MEDIUM"}


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_skipped_tests():
    """Lee los test-ids de Bandit aceptados como riesgo documentado."""
    if not IGNORE_CONFIG.exists():
        return []
    try:
        data = json.loads(IGNORE_CONFIG.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return []
    entries = data.get("skip_tests", []) if isinstance(data, dict) else []
    return [str(item).strip() for item in entries if str(item).strip()]


def bandit_command():
    executable = shutil.which("bandit")
    if executable:
        return [executable]
    code, _stdout, _stderr = run([sys.executable, "-m", "bandit", "--version"])
    if code == 0:
        return [sys.executable, "-m", "bandit"]
    return None


def run(command):
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return completed.returncode, completed.stdout, completed.stderr


def summarize_results(stdout):
    """Extrae (archivo, linea, test_id, severidad, confianza, texto) del JSON de Bandit.

    Devuelve (findings, errors) o (None, None) si la salida no es JSON parseable.
    """
    try:
        data = json.loads(stdout)
    except (ValueError, TypeError):
        return None, None
    findings = []
    for item in (data.get("results", []) if isinstance(data, dict) else []):
        findings.append({
            "file": item.get("filename"),
            "line": item.get("line_number"),
            "test_id": item.get("test_id"),
            "test_name": item.get("test_name"),
            "severity": (item.get("issue_severity") or "").upper(),
            "confidence": (item.get("issue_confidence") or "").upper(),
            "issue": item.get("issue_text"),
            "more_info": item.get("more_info"),
        })
    errors = data.get("errors", []) if isinstance(data, dict) else []
    return findings, errors


def describe(findings):
    parts = []
    for finding in findings:
        rel = finding.get("file")
        try:
            rel = str(Path(rel).relative_to(ROOT)) if rel else rel
        except ValueError:
            pass
        parts.append(f"{rel}:{finding.get('line')} [{finding.get('test_id')} {finding.get('severity')}] {finding.get('issue')}")
    return "; ".join(parts)


def write_result(result):
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"{result['run_id']}.json"
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def main():
    RESULTS.mkdir(parents=True, exist_ok=True)
    started_at = utc_now()
    run_id = f"sast-bandit-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    checks = []
    artifacts = []

    bandit = bandit_command()
    if not bandit:
        checks.append({
            "name": "bandit-availability",
            "status": "fail",
            "message": "Bandit no esta instalado. Instala con: pip install bandit (ver requirements.txt).",
            "details": {"hint": "pip install 'bandit>=1.7,<2'"},
        })
        return finalize(run_id, started_at, checks, artifacts)

    skipped_tests = load_skipped_tests()
    skip_args = ["--skip", ",".join(skipped_tests)] if skipped_tests else []
    if skipped_tests:
        print(f"Test-ids aceptados (skip): {', '.join(skipped_tests)}")

    exclude_arg = ",".join(f"./{d}" for d in EXCLUDED_DIRS)
    command = [*bandit, "-r", ".", "-x", exclude_arg, "-f", "json", *skip_args]
    code, stdout, stderr = run(command)

    raw_path = RESULTS / f"{run_id}.raw.json"
    raw_path.write_text(stdout or stderr, encoding="utf-8")
    artifacts.append(str(raw_path.relative_to(ROOT)))

    findings, errors = summarize_results(stdout)

    if findings is None:
        # Bandit no pudo completar o no devolvio JSON (p.ej. no encontro archivos).
        detail = (stderr or stdout or "").strip().splitlines()
        last = detail[-1] if detail else "sin detalle"
        checks.append({
            "name": "bandit-scan",
            "status": "fail",
            "message": f"Bandit no pudo completar el analisis: {last}",
            "details": {"exit_code": code},
        })
        return finalize(run_id, started_at, checks, artifacts)

    # Agrupa por severidad para un check por nivel; HIGH/MEDIUM bloquean.
    by_severity = {"HIGH": [], "MEDIUM": [], "LOW": []}
    for finding in findings:
        by_severity.setdefault(finding["severity"], []).append(finding)

    for severity in ("HIGH", "MEDIUM", "LOW"):
        bucket = by_severity.get(severity, [])
        blocking = severity in BLOCKING_SEVERITIES
        if not bucket:
            status = "pass"
            message = f"Sin hallazgos de severidad {severity}."
        elif blocking:
            status = "fail"
            message = f"{len(bucket)} hallazgo(s) {severity}: {describe(bucket)}"
            print(f"[FAIL] {message}")
        else:
            status = "pass"
            message = f"{len(bucket)} hallazgo(s) {severity} (no bloqueantes): {describe(bucket)}"
        checks.append({
            "name": f"bandit:{severity.lower()}",
            "status": status,
            "message": message,
            "details": {"count": len(bucket), "findings": bucket, "blocking": blocking},
        })

    if errors:
        checks.append({
            "name": "bandit:errors",
            "status": "fail",
            "message": f"Bandit reporto {len(errors)} error(es) de analisis en algunos archivos.",
            "details": {"errors": errors},
        })

    if skipped_tests:
        checks.append({
            "name": "bandit:accepted-risks",
            "status": "skipped",
            "message": f"Test-ids omitidos por riesgo aceptado: {', '.join(skipped_tests)}.",
            "details": {"skip_tests": skipped_tests},
        })

    return finalize(run_id, started_at, checks, artifacts)


def finalize(run_id, started_at, checks, artifacts):
    if not checks:
        checks.append({
            "name": "bandit-scan",
            "status": "skipped",
            "message": "No se analizo ningun archivo Python.",
            "details": {},
        })

    if any(check["status"] == "fail" for check in checks):
        status = "fail"
    elif all(check["status"] == "skipped" for check in checks):
        status = "skipped"
    else:
        status = "pass"

    result = {
        "schema_version": "1.0",
        "run_id": run_id,
        "tool": "bandit-sast",
        "category": "sast",
        "status": status,
        "started_at": started_at,
        "finished_at": utc_now(),
        "summary": {
            "pass": "SAST (Bandit) completado sin hallazgos bloqueantes (HIGH/MEDIUM).",
            "fail": "SAST (Bandit) encontro hallazgos bloqueantes o no pudo completar.",
            "skipped": "SAST (Bandit) omitido: no habia codigo Python o precondiciones.",
        }[status],
        "checks": checks,
        "artifacts": artifacts,
    }
    path = write_result(result)
    print(path)
    return 1 if status == "fail" else 0


if __name__ == "__main__":
    raise SystemExit(main())
