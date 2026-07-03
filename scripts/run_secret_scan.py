#!/usr/bin/env python3
import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "resultados"
EXCLUDED_DIRS = {".git", "resultados", "node_modules", ".venv", "venv", "__pycache__"}
BINARY_EXTENSIONS = {".xlsx", ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".gz", ".tar", ".7z"}

PATTERNS = [
    ("aws-access-key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("private-key", re.compile(r"-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
    (
        "generic-secret-assignment",
        re.compile(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*['\"][^'\"\s]{16,}['\"]"),
    ),
]


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


def write_result(result):
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"{result['run_id']}.json"
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def iter_scan_files():
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        relative_parts = set(path.relative_to(ROOT).parts[:-1])
        if relative_parts & EXCLUDED_DIRS:
            continue
        if path.suffix.lower() in BINARY_EXTENSIONS:
            continue
        yield path


def fallback_scan():
    findings = []
    scanned_files = 0
    for path in iter_scan_files():
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        scanned_files += 1
        for line_number, line in enumerate(text.splitlines(), start=1):
            for name, pattern in PATTERNS:
                if pattern.search(line):
                    findings.append({
                        "rule": name,
                        "file": str(path.relative_to(ROOT)),
                        "line": line_number,
                    })
    return scanned_files, findings


def main():
    RESULTS.mkdir(parents=True, exist_ok=True)
    started_at = utc_now()
    run_id = f"secret-scan-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    artifacts = []

    if shutil.which("gitleaks"):
        raw_path = RESULTS / f"{run_id}-gitleaks.raw.json"
        code, stdout, stderr = run([
            "gitleaks",
            "detect",
            "--source",
            str(ROOT),
            "--report-format",
            "json",
            "--report-path",
            str(raw_path),
            "--no-banner",
        ])
        artifacts.append(str(raw_path.relative_to(ROOT)))
        status = "pass" if code == 0 else "fail"
        checks = [{
            "name": "gitleaks-detect",
            "status": status,
            "message": "gitleaks no encontro secretos." if status == "pass" else "gitleaks encontro posibles secretos o fallo durante el escaneo.",
            "details": {"exit_code": code, "stderr": stderr.strip()[:1000]},
        }]
    elif shutil.which("trufflehog"):
        code, stdout, stderr = run(["trufflehog", "filesystem", str(ROOT), "--json"])
        raw_path = RESULTS / f"{run_id}-trufflehog.raw.json"
        raw_path.write_text(stdout or stderr, encoding="utf-8")
        artifacts.append(str(raw_path.relative_to(ROOT)))
        status = "pass" if code == 0 and not stdout.strip() else "fail"
        checks = [{
            "name": "trufflehog-filesystem",
            "status": status,
            "message": "trufflehog no encontro secretos." if status == "pass" else "trufflehog encontro posibles secretos o fallo durante el escaneo.",
            "details": {"exit_code": code, "stderr": stderr.strip()[:1000]},
        }]
    else:
        scanned_files, findings = fallback_scan()
        raw_path = RESULTS / f"{run_id}-fallback-findings.json"
        raw_path.write_text(json.dumps(findings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        artifacts.append(str(raw_path.relative_to(ROOT)))
        status = "fail" if findings else "pass"
        checks = [{
            "name": "fallback-secret-regex",
            "status": status,
            "message": "Escaneo regex fallback no encontro secretos." if status == "pass" else "Escaneo regex fallback encontro posibles secretos.",
            "details": {
                "scanned_files": scanned_files,
                "findings": len(findings),
                "note": "Instalar gitleaks o trufflehog mejora cobertura y reduce falsos negativos.",
            },
        }]

    result = {
        "schema_version": "1.0",
        "run_id": run_id,
        "tool": "secret-scan",
        "category": "secret",
        "status": status,
        "started_at": started_at,
        "finished_at": utc_now(),
        "summary": "Escaneo de secretos completado sin hallazgos." if status == "pass" else "Escaneo de secretos encontro hallazgos o fallo.",
        "checks": checks,
        "artifacts": artifacts,
    }
    path = write_result(result)
    print(path)
    return 1 if status == "fail" else 0


if __name__ == "__main__":
    raise SystemExit(main())
