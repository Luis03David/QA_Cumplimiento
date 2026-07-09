#!/usr/bin/env python3
# DAST (analisis dinamico de seguridad) contra el TARGET QA desde afuera, usando
# OWASP ZAP en su modo "baseline" (spider + escaneo pasivo, NO intrusivo: no
# lanza ataques activos, solo observa la app corriendo como lo haria un visitante
# no autenticado o con la sesion provista). Escribe evidencia en el formato
# estandar (category=dast) para el dashboard/seguridad.
#
# A diferencia de SAST (Bandit) que lee NUESTRO codigo, DAST prueba la APP
# DESPLEGADA (missioncontrol.qa.aitops.ai) sin ver su codigo fuente.
#
# Ejecuta ZAP via Docker (imagen oficial). Configuracion por variables de entorno:
#   DAST_TARGET_URL     URL a escanear (default: AITOPS_BASE_URL del .env)
#   DAST_ZAP_IMAGE      imagen de ZAP (default: ghcr.io/zaproxy/zaproxy:stable)
#   DAST_MINUTES        minutos maximos de spider (default 1)
#   DAST_PULL           "1" para hacer docker pull de la imagen si falta
#   AITOPS_ACCESS_CLIENT_ID / AITOPS_ACCESS_CLIENT_SECRET
#                       si estan, se inyectan como cabeceras CF-Access-* para
#                       atravesar Cloudflare Access con un service token.
import json
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "resultados"
DEFAULT_IMAGE = "ghcr.io/zaproxy/zaproxy:stable"

# riskcode de ZAP -> severidad. High/Medium bloquean; Low/Informational se reportan.
RISK_LABELS = {"3": "High", "2": "Medium", "1": "Low", "0": "Informational"}
BLOCKING_RISKS = {"3", "2"}


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run(command, timeout=None):
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=timeout,
    )
    return completed.returncode, completed.stdout, completed.stderr


def load_dotenv_value(key):
    """Lee una clave del .env sin depender de librerias externas."""
    if os.environ.get(key):
        return os.environ[key]
    env_file = ROOT / ".env"
    if not env_file.exists():
        return ""
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def target_url():
    explicit = os.environ.get("DAST_TARGET_URL", "").strip()
    if explicit:
        return explicit
    return load_dotenv_value("AITOPS_BASE_URL").strip()


def access_header_config():
    """Construye opciones -config del 'replacer' de ZAP para inyectar las
    cabeceras de Cloudflare Access, si hay service token configurado."""
    client_id = load_dotenv_value("AITOPS_ACCESS_CLIENT_ID")
    client_secret = load_dotenv_value("AITOPS_ACCESS_CLIENT_SECRET")
    if not client_id or not client_secret:
        return [], False
    rules = [
        ("CF-Access-Client-Id", client_id),
        ("CF-Access-Client-Secret", client_secret),
    ]
    args = []
    for index, (header, value) in enumerate(rules):
        prefix = f"replacer.full_list({index})"
        args += [
            "-config", f"{prefix}.description=cfaccess-{index}",
            "-config", f"{prefix}.enabled=true",
            "-config", f"{prefix}.matchtype=REQ_HEADER",
            "-config", f"{prefix}.matchstr={header}",
            "-config", f"{prefix}.regex=false",
            "-config", f"{prefix}.replacement={value}",
        ]
    return args, True


def docker_available():
    return shutil.which("docker") is not None


def image_present(image):
    code, _out, _err = run(["docker", "image", "inspect", image])
    return code == 0


def write_result(result):
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"{result['run_id']}.json"
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def summarize_zap(report):
    """Aplana site[].alerts[] de ZAP a una lista de hallazgos legible."""
    findings = []
    for site in (report.get("site", []) if isinstance(report, dict) else []):
        site_name = site.get("@name")
        for alert in site.get("alerts", []) or []:
            risk = str(alert.get("riskcode", "0"))
            findings.append({
                "site": site_name,
                "risk": RISK_LABELS.get(risk, risk),
                "riskcode": risk,
                "confidence": alert.get("confidence"),
                "name": alert.get("alert") or alert.get("name"),
                "cwe": alert.get("cweid"),
                "instances": len(alert.get("instances", []) or []) or int(alert.get("count", 0) or 0),
                "solution": (alert.get("solution") or "").strip()[:300],
            })
    return findings


def describe(findings):
    parts = []
    for finding in findings:
        parts.append(f"{finding['name']} [{finding['risk']}] x{finding['instances']} (CWE-{finding.get('cwe')})")
    return "; ".join(parts)


def main():
    RESULTS.mkdir(parents=True, exist_ok=True)
    started_at = utc_now()
    run_id = f"dast-zap-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    checks = []
    artifacts = []

    target = target_url()
    image = os.environ.get("DAST_ZAP_IMAGE", DEFAULT_IMAGE).strip() or DEFAULT_IMAGE
    minutes = os.environ.get("DAST_MINUTES", "1").strip() or "1"

    if not target:
        checks.append({
            "name": "dast-target",
            "status": "skipped",
            "message": "Sin target: define DAST_TARGET_URL o AITOPS_BASE_URL en .env.",
            "details": {},
        })
        return finalize(run_id, started_at, target, checks, artifacts)

    if not docker_available():
        checks.append({
            "name": "zap-availability",
            "status": "fail",
            "message": "Docker no esta disponible. OWASP ZAP baseline corre via Docker. Instala Docker o usa el workflow de CI dast-zap.yml.",
            "details": {"image": image},
        })
        return finalize(run_id, started_at, target, checks, artifacts)

    if not image_present(image):
        if os.environ.get("DAST_PULL", "").strip() == "1":
            print(f"docker pull {image} ...")
            code, _out, err = run(["docker", "pull", image], timeout=600)
            if code != 0:
                checks.append({
                    "name": "zap-image",
                    "status": "fail",
                    "message": f"No se pudo descargar la imagen {image}: {err.strip().splitlines()[-1] if err.strip() else 'error'}",
                    "details": {"image": image},
                })
                return finalize(run_id, started_at, target, checks, artifacts)
        else:
            checks.append({
                "name": "zap-image",
                "status": "skipped",
                "message": f"Imagen {image} no presente. Descarga con: docker pull {image} (o corre con DAST_PULL=1).",
                "details": {"image": image, "hint": f"docker pull {image}"},
            })
            return finalize(run_id, started_at, target, checks, artifacts)

    report_name = f"{run_id}.zap.json"
    header_args, used_access = access_header_config()
    if used_access:
        print("Inyectando cabeceras Cloudflare Access (service token).")

    # ZAP corre en el contenedor como uid 1000 y no siempre coincide con el uid
    # del host: si montamos resultados/ directo, ZAP no puede escribir el reporte
    # (AccessDenied). Usamos un directorio de trabajo temporal world-writable como
    # /zap/wrk y luego copiamos el reporte a resultados/.
    work_dir = Path(tempfile.mkdtemp(prefix="zap-wrk-"))
    os.chmod(work_dir, 0o777)
    work_report = work_dir / report_name

    # -I: no cambiar exit code por warnings (parseamos el JSON para el gating).
    zap_cmd = ["zap-baseline.py", "-t", target, "-J", report_name, "-m", minutes, "-I"]
    if header_args:
        zap_cmd += ["-z", " ".join(header_args)]

    docker_cmd = [
        "docker", "run", "--rm",
        "-v", f"{work_dir}:/zap/wrk/:rw",
        image,
        *zap_cmd,
    ]
    print("Ejecutando OWASP ZAP baseline (spider + pasivo, no intrusivo)...")
    print(" ".join(docker_cmd))
    try:
        code, stdout, stderr = run(docker_cmd, timeout=1200)
    except subprocess.TimeoutExpired:
        shutil.rmtree(work_dir, ignore_errors=True)
        checks.append({
            "name": "zap-baseline",
            "status": "fail",
            "message": "El escaneo ZAP excedio el tiempo maximo (1200s).",
            "details": {"target": target},
        })
        return finalize(run_id, started_at, target, checks, artifacts)

    print(stdout[-2000:] if stdout else "")

    # Mueve el reporte del work dir temporal a resultados/.
    report_path = RESULTS / report_name
    if work_report.exists():
        shutil.move(str(work_report), str(report_path))
    shutil.rmtree(work_dir, ignore_errors=True)

    if not report_path.exists():
        detail = (stderr or stdout or "").strip().splitlines()
        last = detail[-1] if detail else "sin salida"
        checks.append({
            "name": "zap-baseline",
            "status": "fail",
            "message": f"ZAP no genero reporte JSON. Ultima linea: {last}",
            "details": {"target": target, "exit_code": code},
        })
        return finalize(run_id, started_at, target, checks, artifacts)

    artifacts.append(str(report_path.relative_to(ROOT)))
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        checks.append({
            "name": "zap-baseline",
            "status": "fail",
            "message": "El reporte de ZAP no es JSON parseable.",
            "details": {"target": target},
        })
        return finalize(run_id, started_at, target, checks, artifacts)

    findings = summarize_zap(report)
    by_risk = {"High": [], "Medium": [], "Low": [], "Informational": []}
    for finding in findings:
        by_risk.setdefault(finding["risk"], []).append(finding)

    for risk in ("High", "Medium", "Low", "Informational"):
        bucket = by_risk.get(risk, [])
        blocking = risk in ("High", "Medium")
        if not bucket:
            status = "pass"
            message = f"Sin alertas {risk}."
        elif blocking:
            status = "fail"
            message = f"{len(bucket)} alerta(s) {risk}: {describe(bucket)}"
            print(f"[FAIL] {message}")
        else:
            status = "pass"
            message = f"{len(bucket)} alerta(s) {risk} (no bloqueantes): {describe(bucket)}"
        checks.append({
            "name": f"zap:{risk.lower()}",
            "status": status,
            "message": message,
            "details": {"count": len(bucket), "findings": bucket, "blocking": blocking},
        })

    checks.append({
        "name": "zap:access",
        "status": "pass" if used_access else "skipped",
        "message": "Escaneo con service token de Cloudflare Access (atraviesa el login)." if used_access
        else "Escaneo sin service token: ZAP ve el borde/login de Access, no la app autenticada. Configura AITOPS_ACCESS_CLIENT_ID/SECRET para DAST de la app real.",
        "details": {"used_access": used_access},
    })

    return finalize(run_id, started_at, target, checks, artifacts)


def finalize(run_id, started_at, target, checks, artifacts):
    if not checks:
        checks.append({"name": "zap-baseline", "status": "skipped", "message": "Sin resultados.", "details": {}})

    if any(check["status"] == "fail" for check in checks):
        status = "fail"
    elif all(check["status"] == "skipped" for check in checks):
        status = "skipped"
    else:
        status = "pass"

    # DAST del borde/login (sin service token) se mide, pero la superficie es "edge".
    used_access = any(c["name"] == "zap:access" and c["status"] == "pass" for c in checks)
    surface = "app" if used_access else "edge"

    result = {
        "schema_version": "1.0",
        "run_id": run_id,
        "tool": "zap-baseline",
        "category": "dast",
        "surface": surface if status != "skipped" else None,
        "status": status,
        "started_at": started_at,
        "finished_at": utc_now(),
        "summary": {
            "pass": f"DAST (OWASP ZAP) contra {target} sin alertas bloqueantes (High/Medium).",
            "fail": f"DAST (OWASP ZAP) contra {target} encontro alertas bloqueantes o no pudo completar.",
            "skipped": "DAST (OWASP ZAP) omitido: falta target, imagen o Docker.",
        }[status],
        "checks": checks,
        "artifacts": artifacts,
    }
    path = write_result(result)
    print(path)
    return 1 if status == "fail" else 0


if __name__ == "__main__":
    raise SystemExit(main())
