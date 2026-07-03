#!/usr/bin/env python3
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "resultados"


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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


def pip_audit_command():
    executable = shutil.which("pip-audit")
    if executable:
        return [executable]
    code, _stdout, _stderr = run([sys.executable, "-m", "pip_audit", "--version"])
    if code == 0:
        return [sys.executable, "-m", "pip_audit"]
    return None


def write_result(result):
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"{result['run_id']}.json"
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def main():
    RESULTS.mkdir(parents=True, exist_ok=True)
    started_at = utc_now()
    run_id = f"dependency-audit-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    checks = []
    artifacts = []

    npm_lockfiles = sorted(ROOT.glob("package-lock.json")) + sorted(ROOT.glob("npm-shrinkwrap.json"))
    python_requirements = sorted(ROOT.glob("requirements*.txt"))

    if npm_lockfiles:
        if not shutil.which("npm"):
            checks.append({
                "name": "npm-audit",
                "status": "fail",
                "message": "Se encontro lockfile de npm, pero npm no esta instalado.",
                "details": {"lockfiles": [str(p.relative_to(ROOT)) for p in npm_lockfiles]},
            })
        else:
            code, stdout, stderr = run(["npm", "audit", "--json"])
            raw_path = RESULTS / f"{run_id}-npm-audit.raw.json"
            raw_path.write_text(stdout or stderr, encoding="utf-8")
            artifacts.append(str(raw_path.relative_to(ROOT)))
            status = "pass" if code == 0 else "fail"
            checks.append({
                "name": "npm-audit",
                "status": status,
                "message": "npm audit finalizo sin vulnerabilidades bloqueantes." if status == "pass" else "npm audit reporto vulnerabilidades o no pudo completar correctamente.",
                "details": {"exit_code": code, "lockfiles": [str(p.relative_to(ROOT)) for p in npm_lockfiles]},
            })

    if python_requirements:
        pip_audit = pip_audit_command()
        if not pip_audit:
            checks.append({
                "name": "pip-audit",
                "status": "fail",
                "message": "Se encontraron requirements, pero pip-audit no esta instalado.",
                "details": {"requirements": [str(p.relative_to(ROOT)) for p in python_requirements]},
            })
        else:
            for req in python_requirements:
                code, stdout, stderr = run([*pip_audit, "-r", str(req), "-f", "json"])
                raw_path = RESULTS / f"{run_id}-{req.stem}.raw.json"
                raw_path.write_text(stdout or stderr, encoding="utf-8")
                artifacts.append(str(raw_path.relative_to(ROOT)))
                status = "pass" if code == 0 else "fail"
                checks.append({
                    "name": f"pip-audit:{req.name}",
                    "status": status,
                    "message": "pip-audit finalizo sin vulnerabilidades conocidas." if status == "pass" else "pip-audit reporto vulnerabilidades o no pudo completar correctamente.",
                    "details": {"exit_code": code, "requirements": str(req.relative_to(ROOT))},
                })

    if not checks:
        checks.append({
            "name": "manifest-discovery",
            "status": "skipped",
            "message": "No se encontraron manifiestos soportados de dependencias.",
            "details": {"supported": ["package-lock.json", "npm-shrinkwrap.json", "requirements*.txt"]},
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
        "tool": "dependency-audit",
        "category": "dependency",
        "status": status,
        "started_at": started_at,
        "finished_at": utc_now(),
        "summary": {
            "pass": "Escaneo de dependencias completado sin hallazgos bloqueantes.",
            "fail": "Escaneo de dependencias encontro hallazgos o precondiciones faltantes.",
            "skipped": "Escaneo de dependencias omitido: no hay manifiestos soportados.",
        }[status],
        "checks": checks,
        "artifacts": artifacts,
    }
    path = write_result(result)
    print(path)
    return 1 if status == "fail" else 0


if __name__ == "__main__":
    raise SystemExit(main())
