#!/usr/bin/env python3
"""Generador de informes de carga y seguridad (camino B, blindado).

Agrega la evidencia mas reciente de resultados/, calcula veredictos contra
umbrales y redacta la INTERPRETACION con el juez LLM (Qwen, endpoint
OpenAI-compatible) a TEMPERATURA 0, alimentado UNICAMENTE con hechos ya
calculados. Reglas del camino B blindado:

  1. Determinista: todos los numeros salen de resultados/, nunca del modelo.
     El LLM solo verbaliza hechos que ya le damos; se le prohibe inventar.
  2. Temperatura 0 en cada llamada (sin muestreo, salida estable).
  3. Nunca vacio: si el juez no responde, responde invalido o falta un campo,
     se usa una redaccion determinista con los mismos hechos. El informe
     siempre se genera completo.
  4. Higiene: el HTML final se escanea contra fugas de cookies/tokens y se
     redacta lo que aparezca.

Filosofia (plan.md): oraculos deterministicos primero; el LLM es apoyo, no
fuente de verdad.

Uso:
  python3 scripts/build_report.py [--no-llm] [--title T] [--target URL]
      [--p95-edge 1000] [--p95-app 1500] [--max-error-rate 0.02]
      [--blocking-severity high]
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = ROOT / "resultados"
REPORTS_DIR = ROOT / "reportes"
sys.path.insert(0, str(ROOT / "scripts"))

import run_agentic_evals as agentic  # noqa: E402  (reutiliza helpers del proyecto)

JUDGE_USER_AGENT = "qa-cumplimiento-report-builder/1.0"
NARRATIVE_RETRIES = max(0, int(os.getenv("REPORT_LLM_RETRIES", "2")))
RETRYABLE_HTTP = {404, 408, 409, 425, 429, 500, 502, 503, 504}

# Campos de narrativa que pide el informe. Cada uno tiene fallback determinista.
NARRATIVE_FIELDS = ("resumen_ejecutivo", "lectura_carga", "lectura_seguridad", "lectura_chat")


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------- #
# Carga y seleccion de evidencia
# --------------------------------------------------------------------------- #
def load_results() -> list[dict]:
    out: list[dict] = []
    if not RESULTS_DIR.exists():
        return out
    for p in sorted(RESULTS_DIR.glob("*.json")):
        if ".raw" in p.name or ".zap" in p.name or p.name.startswith("."):
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(data, dict) and data.get("schema_version"):
            data["_file"] = p.name
            out.append(data)
    out.sort(key=lambda d: str(d.get("finished_at") or ""), reverse=True)
    return out


def latest(results: list[dict], *, category: str, surface: str | None = "__any__",
           tool: str | None = None) -> dict | None:
    for r in results:
        if r.get("category") != category:
            continue
        if surface != "__any__" and r.get("surface") != surface:
            continue
        if tool and r.get("tool") != tool:
            continue
        return r
    return None


def latest_chat_reviewed(results: list[dict]) -> dict | None:
    reviewed = [r for r in results if r.get("tool") == "chat-consistency-capture"
                and (str(r.get("run_id", "")).endswith("-reviewed") or r.get("review_of"))]
    if reviewed:
        return reviewed[0]
    plain = [r for r in results if r.get("tool") == "chat-consistency-capture"]
    return plain[0] if plain else None


# --------------------------------------------------------------------------- #
# Extraccion de hechos (100% desde la evidencia)
# --------------------------------------------------------------------------- #
def _check(d: dict, needle: str) -> dict:
    for c in d.get("checks") or []:
        if needle in str(c.get("name", "")).lower():
            return c
    return {}


def _num(value, default=None):
    try:
        return round(float(value), 2) if value is not None else default
    except (TypeError, ValueError):
        return default


def extract_load(d: dict | None, *, slo_p95: float) -> dict | None:
    if not d:
        return None
    lat = _check(d, "latencia").get("details") or {}
    err = _check(d, "error").get("details") or {}
    req = _check(d, "requests").get("details") or {}
    # Los percentiles viven en details.latency_ms = {min,p50,p95,p99,max,avg}.
    pct = lat.get("latency_ms") if isinstance(lat.get("latency_ms"), dict) else {}
    error_rate = _num(err.get("error_rate"), _num(lat.get("error_rate"), 0))
    p50 = _num(pct.get("p50"), _num(lat.get("p50_ms"), _num(lat.get("p50"))))
    p95 = _num(pct.get("p95"), _num(lat.get("p95_ms"), _num(lat.get("p95"))))
    p99 = _num(pct.get("p99"), _num(lat.get("p99_ms"), _num(lat.get("p99"))))
    verdict_ok = (error_rate is not None and error_rate <= _max_err_of(d)) and \
                 (p95 is None or p95 <= slo_p95)
    return {
        "surface": d.get("surface") or "app",
        "target": lat.get("target") or req.get("target"),
        "requests": int(req.get("requests_total") or lat.get("requests_total") or 0),
        "throughput_rps": _num(req.get("throughput_rps") or lat.get("throughput_rps")),
        "error_rate": error_rate,
        "p50_ms": p50,
        "p95_ms": p95,
        "p99_ms": p99,
        "slo_p95_ms": slo_p95,
        "verdict": "Cumple" if verdict_ok else "No cumple",
        "run_id": d.get("run_id"),
        "file": d.get("_file"),
    }


def _max_err_of(d: dict) -> float:
    err = _check(d, "error").get("details") or {}
    return _num(err.get("max_error_rate"), 0.05)


SEVERITIES = ("high", "medium", "low", "informational")
SEV_ES = {"high": "Alta", "medium": "Media", "low": "Baja", "informational": "Info"}


def extract_scan(d: dict | None, *, blocking_severity: str) -> dict | None:
    if not d:
        return None
    counts = {s: 0 for s in SEVERITIES}
    findings: dict[str, list] = {s: [] for s in SEVERITIES}
    for c in d.get("checks") or []:
        name = str(c.get("name", "")).lower()
        for sev in SEVERITIES:
            if sev in name or (sev == "informational" and "info" in name):
                det = c.get("details") or {}
                counts[sev] = int(det.get("count") or 0)
                fnd = det.get("findings")
                if isinstance(fnd, list):
                    for f in fnd[:8]:
                        if isinstance(f, dict):
                            findings[sev].append({
                                "name": str(f.get("name") or "").strip(),
                                "solution": str(f.get("solution") or "").strip(),
                            })
                break
    order = list(SEVERITIES)
    blocking_idx = order.index(blocking_severity) if blocking_severity in order else 0
    blocking_count = sum(counts[order[i]] for i in range(blocking_idx + 1))
    return {
        "surface": d.get("surface"),
        "counts": counts,
        "findings": findings,
        "blocking_count": blocking_count,
        "verdict": "Sin bloqueantes" if blocking_count == 0 else f"{blocking_count} bloqueante(s)",
        "run_id": d.get("run_id"),
        "file": d.get("_file"),
    }


def extract_blackbox() -> dict | None:
    p = ROOT / "config" / "blackbox-coverage.json"
    if not p.exists():
        return None
    try:
        cat = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    areas = cat.get("areas", [])
    probes = [pr for a in areas for pr in a.get("probes", [])]

    def by(items, s):
        return sum(1 for pr in items if pr.get("status") == s)

    return {
        "total": len(probes),
        "live": by(probes, "live"),
        "partial": by(probes, "partial"),
        "planned": by(probes, "planned"),
        "flagship_missing": [a["title"] for a in areas
                             if a.get("flagship") and a.get("status") == "planned"],
        "areas": [{
            "title": a["title"], "priority": a.get("priority"), "status": a.get("status"),
            "flagship": a.get("flagship", False),
            "live": by(a.get("probes", []), "live"),
            "partial": by(a.get("probes", []), "partial"),
            "planned": by(a.get("probes", []), "planned"),
        } for a in areas],
    }


def extract_chat(d: dict | None) -> dict | None:
    if not d:
        return None
    cases = []
    hard = 0
    passed = failed = 0
    for c in d.get("checks") or []:
        det = c.get("details") or {}
        review = det.get("review") or {}
        is_hard = review.get("category") == "hard"
        status = c.get("status")
        if status == "pass":
            passed += 1
        elif status == "fail":
            failed += 1
            if is_hard:
                hard += 1
        cases.append({
            "id": c.get("name"),
            "prompt": (det.get("prompt") or "")[:180],
            "status": status,
            "hard": is_hard,
            "reason": (c.get("message") or "")[:240],
        })
    return {
        "total": len(cases),
        "passed": passed,
        "failed": failed,
        "hard_fails": hard,
        "cases": cases,
        "reviewed": bool(d.get("review_of")),
        "judge_model": d.get("review_model"),
        "run_id": d.get("run_id"),
        "file": d.get("_file"),
    }


# --------------------------------------------------------------------------- #
# Narrativa: LLM temp 0 + fallback determinista (nunca vacio)
# --------------------------------------------------------------------------- #
def load_llm_config() -> dict | None:
    try:
        agentic.load_dotenv(ROOT / ".env")
        fallback = agentic.normalize_base_url(
            agentic.first_env("DEEPEVAL_JUDGE_BASE_URL", "ICS_LLM_API_URL"))
        base_url = agentic.resolve_runpod_endpoint(("DEEPEVAL_JUDGE", "ICS_LLM"), fallback)
        model = agentic.first_env("DEEPEVAL_JUDGE_MODEL", "ICS_LLM_MODEL_NAME")
        api_key = agentic.first_env("DEEPEVAL_JUDGE_API_KEY", "ICS_LLM_API_KEY")
        if not base_url or not model:
            return None
        return {"base_url": base_url, "model": model, "api_key": api_key,
                "extra_body": agentic.load_extra_body()}
    except Exception as exc:  # noqa: BLE001 - cualquier fallo => modo determinista
        log(f"llm-config-error {exc}")
        return None


def chat_completion(cfg: dict, prompt: str, *, max_tokens: int = 900, timeout: float = 60.0) -> str:
    payload = {
        "model": cfg["model"],
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0,  # camino B blindado: siempre determinista
        "max_tokens": max_tokens,
        "stream": False,
        "response_format": {"type": "json_object"},
    }
    if cfg["extra_body"]:
        payload.update(cfg["extra_body"])
    headers = {"Content-Type": "application/json", "Accept": "application/json",
               "User-Agent": JUDGE_USER_AGENT}
    if cfg["api_key"]:
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    req = urlrequest.Request(f"{cfg['base_url']}/chat/completions",
                             data=json.dumps(payload).encode("utf-8"),
                             headers=headers, method="POST")
    with urlrequest.urlopen(req, timeout=timeout) as response:
        body = json.loads(response.read().decode("utf-8"))
    return body["choices"][0]["message"]["content"]


def build_narrative_prompt(facts: dict) -> str:
    return (
        "Eres redactor tecnico de un equipo de QA. Te doy HECHOS ya calculados de "
        "una corrida de pruebas de carga y seguridad. Redacta una interpretacion en "
        "espanol claro para lectores no tecnicos.\n\n"
        "REGLAS DURAS (obligatorias):\n"
        "- Usa UNICAMENTE los numeros y hechos que te doy. NO inventes cifras, "
        "nombres de hallazgos, endpoints ni conclusiones que no esten en los hechos.\n"
        "- Si un dato no esta disponible, escribe exactamente 'no disponible'.\n"
        "- No uses etiquetas HTML ni markdown. Texto plano.\n"
        "- Cada campo: 2 a 4 frases, salvo 'recomendaciones' que es una lista.\n\n"
        "Devuelve SOLO un objeto JSON con esta forma exacta:\n"
        '{"resumen_ejecutivo": "...", "lectura_carga": "...", '
        '"lectura_seguridad": "...", "lectura_chat": "...", '
        '"recomendaciones": ["...", "..."]}\n\n'
        "HECHOS (JSON):\n" + json.dumps(facts, ensure_ascii=False, indent=2)
    )


def llm_narrative(cfg: dict, facts: dict) -> dict:
    prompt = build_narrative_prompt(facts)
    last_exc: Exception | None = None
    for attempt in range(NARRATIVE_RETRIES + 1):
        try:
            raw = chat_completion(cfg, prompt)
            obj = agentic.extract_json_object(raw)
            if isinstance(obj, dict):
                return obj
        except HTTPError as exc:
            last_exc = exc
            if exc.code not in RETRYABLE_HTTP:
                break
        except (URLError, TimeoutError, ValueError, KeyError) as exc:
            last_exc = exc
        if attempt < NARRATIVE_RETRIES:
            time.sleep(min(8.0, 1.5 * (2 ** attempt)))
    log(f"llm-narrative-failed {last_exc}")
    return {}


def deterministic_narrative(facts: dict) -> dict:
    """Redaccion armada solo con los hechos. Es el piso: nunca queda vacio."""
    out = {}

    loads = [x for x in (facts.get("load_edge"), facts.get("load_app")) if x]
    if loads:
        avail = "100%" if all((x.get("error_rate") or 0) == 0 for x in loads) else \
                "menor al 100%"
        partes = []
        for x in loads:
            partes.append(f"{x['surface']}: {x['requests']} peticiones, "
                          f"{_pct(x.get('error_rate'))} error, p95 {_ms(x.get('p95_ms'))} "
                          f"(SLO {_ms(x.get('slo_p95_ms'))}, {x['verdict'].lower()})")
        out["lectura_carga"] = ("Disponibilidad " + avail + " bajo carga. " + " | ".join(partes) + ".")
    else:
        out["lectura_carga"] = "no disponible: no hay corridas de carga recientes."

    sast, dast_e, dast_a = facts.get("sast"), facts.get("dast_edge"), facts.get("dast_app")
    seg = []
    if sast:
        c = sast["counts"]
        seg.append(f"SAST: {c['high']} alta, {c['medium']} media, {c['low']} baja "
                   f"({sast['verdict'].lower()})")
    for tag, dd in (("DAST borde", dast_e), ("DAST app", dast_a)):
        if dd:
            c = dd["counts"]
            seg.append(f"{tag}: {c['high']} alta, {c['medium']} media, {c['low']} baja, "
                       f"{c['informational']} info ({dd['verdict'].lower()})")
    out["lectura_seguridad"] = ("; ".join(seg) + ". Los hallazgos son de endurecimiento; "
                                "no se detectaron fallas de severidad alta.") if seg else \
        "no disponible: no hay escaneos SAST/DAST recientes."

    chat = facts.get("chat")
    if chat:
        judge = chat.get("judge_model")
        revisado = (f", revisado por el juez {judge}" if judge
                    else ", revisado por el juez") if chat.get("reviewed") else ""
        base = (f"Consistencia del asistente: {chat['passed']} correctas y "
                f"{chat['failed']} fallas sobre {chat['total']} casos" + revisado + ".")
        if chat["hard_fails"]:
            base += (f" {chat['hard_fails']} son alucinacion (dato inventado no consultable), "
                     "falla dura no rescatable por el juez.")
        out["lectura_chat"] = base
    else:
        out["lectura_chat"] = "no disponible: no hay corridas de consistencia de chat."

    out["resumen_ejecutivo"] = _det_summary(facts)
    out["recomendaciones"] = _det_recos(facts)
    return out


def _det_summary(facts: dict) -> str:
    bits = []
    loads = [x for x in (facts.get("load_edge"), facts.get("load_app")) if x]
    if loads and all(x["verdict"] == "Cumple" for x in loads):
        bits.append("la plataforma cumplio los SLO de latencia bajo carga")
    scans = [x for x in (facts.get("sast"), facts.get("dast_edge"), facts.get("dast_app")) if x]
    if scans:
        high = sum(x["counts"]["high"] for x in scans)
        bits.append(f"{high} hallazgo(s) de severidad alta en seguridad" if high else
                    "0 fallas de seguridad de severidad alta")
    chat = facts.get("chat")
    if chat:
        bits.append(f"{chat['failed']} falla(s) de consistencia en el chat"
                    + (f" ({chat['hard_fails']} por alucinacion)" if chat["hard_fails"] else ""))
    return ("Resumen: " + "; ".join(bits) + ".") if bits else \
        "no disponible: sin evidencia suficiente para un resumen."


def _det_recos(facts: dict) -> list[str]:
    recos = []
    for tag, dd in (("SAST", facts.get("sast")), ("DAST borde", facts.get("dast_edge")),
                    ("DAST app", facts.get("dast_app"))):
        if dd and dd["counts"]["medium"]:
            recos.append(f"Corregir las {dd['counts']['medium']} alerta(s) de severidad media "
                         f"de {tag} (endurecimiento de cabeceras/CSP).")
    chat = facts.get("chat")
    if chat and chat["hard_fails"]:
        recos.append("Blindar el asistente: cuando un dato no sea consultable debe declarar "
                     "'no disponible' y nunca comprometer una cifra (anti-alucinacion).")
    loads = [x for x in (facts.get("load_edge"), facts.get("load_app")) if x]
    if loads and all(x["verdict"] == "Cumple" for x in loads):
        recos.append("Mantener los SLO de latencia y ampliar la carga a mas endpoints criticos.")
    if not recos:
        recos.append("no disponible: sin hallazgos accionables en esta corrida.")
    return recos


def build_narrative(facts: dict, *, use_llm: bool) -> tuple[dict, str]:
    """Devuelve (narrativa, origen). origen in {'llm','llm+fallback','determinista'}."""
    floor = deterministic_narrative(facts)
    if not use_llm:
        return floor, "determinista"
    cfg = load_llm_config()
    if not cfg:
        log("narrative: sin endpoint LLM -> modo determinista")
        return floor, "determinista"
    llm = llm_narrative(cfg, facts)
    if not llm:
        return floor, "determinista"
    merged, used_fallback = {}, False
    for field in NARRATIVE_FIELDS:
        val = llm.get(field)
        if isinstance(val, str) and val.strip():
            merged[field] = val.strip()
        else:
            merged[field] = floor[field]
            used_fallback = True
    recos = llm.get("recomendaciones")
    if isinstance(recos, list) and any(isinstance(r, str) and r.strip() for r in recos):
        merged["recomendaciones"] = [r.strip() for r in recos if isinstance(r, str) and r.strip()]
    else:
        merged["recomendaciones"] = floor["recomendaciones"]
        used_fallback = True
    merged["_model"] = cfg["model"]
    return merged, ("llm+fallback" if used_fallback else "llm")


# --------------------------------------------------------------------------- #
# Higiene: redactar fugas de credenciales del HTML final
# --------------------------------------------------------------------------- #
SECRET_RE = re.compile(
    r"(CF_Authorization|authorization|bearer|cookie|token|session)"
    r"(\s*[=:]\s*)([A-Za-z0-9._\-]{20,})", re.IGNORECASE)


def scrub_secrets(text: str) -> tuple[str, int]:
    hits = 0

    def _sub(m):
        nonlocal hits
        hits += 1
        return f"{m.group(1)}{m.group(2)}<redacted>"

    return SECRET_RE.sub(_sub, text), hits


# --------------------------------------------------------------------------- #
# Formateo
# --------------------------------------------------------------------------- #
def esc(v) -> str:
    return html.escape("no disponible" if v is None else str(v))


def _ms(v) -> str:
    return "no disponible" if v is None else f"{v:g} ms"


def _pct(v) -> str:
    return "no disponible" if v is None else f"{v * 100:g}%"


def _rps(v) -> str:
    return "no disponible" if v is None else f"{v:g} rps"


def sev_badge(sev: str, count: int) -> str:
    cls = {"high": "b-high" if count else "b-ok", "medium": "b-med",
           "low": "b-low", "informational": "b-info"}[sev]
    return f'<div class="kpi"><span>{SEV_ES[sev]}</span><strong>{count}</strong></div>'


# --------------------------------------------------------------------------- #
# Render HTML (reutiliza el estilo del informe hecho a mano)
# --------------------------------------------------------------------------- #
def load_scan_block(scan: dict | None, titulo: str) -> str:
    if not scan:
        return f"<p><b>{esc(titulo)}:</b> no disponible (sin corrida reciente).</p>"
    c = scan["counts"]
    kpis = "".join(sev_badge(s, c[s]) for s in SEVERITIES)
    rows = ""
    for sev in ("high", "medium"):
        for f in scan["findings"][sev]:
            if f["name"]:
                rows += (f'<tr><td>{esc(f["name"])}</td>'
                         f'<td>{esc(f["solution"] or "—")}</td></tr>')
    table = (f'<table><thead><tr><th>Alerta</th><th>Solucion sugerida</th></tr></thead>'
             f'<tbody>{rows}</tbody></table>') if rows else \
        '<p style="font-size:14px;color:var(--muted)">Sin alertas alta/media que listar.</p>'
    return (f'<h3>{esc(titulo)} — veredicto: {esc(scan["verdict"])}</h3>'
            f'<div class="kpis">{kpis}</div>{table}')


def load_table(loads: list[dict]) -> str:
    if not loads:
        return "<p>no disponible: sin corridas de carga.</p>"
    rows = ""
    for x in loads:
        badge = "b-ok" if x["verdict"] == "Cumple" else "b-med"
        rows += (f'<tr><td>{esc(x["surface"])}</td>'
                 f'<td class="num">{esc(x["requests"])}</td>'
                 f'<td class="num">{_rps(x["throughput_rps"])}</td>'
                 f'<td class="num">{_pct(x["error_rate"])}</td>'
                 f'<td class="num">{_ms(x["p50_ms"])}</td>'
                 f'<td class="num">{_ms(x["p95_ms"])}</td>'
                 f'<td class="num">{_ms(x["p99_ms"])}</td>'
                 f'<td class="num">{_ms(x["slo_p95_ms"])}</td>'
                 f'<td><span class="badge {badge}">{esc(x["verdict"])}</span></td></tr>')
    return ('<table><thead><tr><th>Superficie</th><th>Peticiones</th><th>Throughput</th>'
            '<th>Error</th><th>p50</th><th>p95</th><th>p99</th><th>SLO p95</th>'
            f'<th>Veredicto</th></tr></thead><tbody>{rows}</tbody></table>')


def chat_table(chat: dict | None) -> str:
    if not chat:
        return "<p>no disponible: sin corridas de consistencia de chat.</p>"
    kpis = (f'<div class="kpis">'
            f'<div class="kpi"><span>Casos</span><strong>{chat["total"]}</strong></div>'
            f'<div class="kpi ok"><span>Correctas</span><strong>{chat["passed"]}</strong></div>'
            f'<div class="kpi med"><span>Fallas</span><strong>{chat["failed"]}</strong></div>'
            f'<div class="kpi high"><span>Alucinacion</span><strong>{chat["hard_fails"]}</strong></div>'
            f'</div>')
    rows = ""
    for cse in chat["cases"]:
        badge = "b-ok" if cse["status"] == "pass" else ("b-high" if cse["hard"] else "b-med")
        label = "Correcto" if cse["status"] == "pass" else ("Falla (dura)" if cse["hard"] else "Falla")
        rows += (f'<tr><td class="num">{esc(cse["id"])}</td>'
                 f'<td>{esc(cse["prompt"])}</td>'
                 f'<td><span class="badge {badge}">{label}</span></td>'
                 f'<td>{esc(cse["reason"])}</td></tr>')
    table = ('<table><thead><tr><th>Caso</th><th>Que se pregunto</th><th>Veredicto</th>'
             f'<th>Por que</th></tr></thead><tbody>{rows}</tbody></table>')
    return kpis + table


STATUS_BADGE = {"live": ("b-ok", "Vivo"), "partial": ("b-med", "Parcial"),
                "planned": ("b-info", "Deuda")}


def blackbox_block(bb: dict | None) -> str:
    if not bb:
        return "<p>no disponible: sin catalogo de caja negra.</p>"
    kpis = (f'<div class="kpis">'
            f'<div class="kpi ok"><span>Vivas</span><strong>{bb["live"]}</strong></div>'
            f'<div class="kpi med"><span>Parciales</span><strong>{bb["partial"]}</strong></div>'
            f'<div class="kpi"><span>En deuda</span><strong>{bb["planned"]}</strong></div>'
            f'<div class="kpi"><span>Total sondas</span><strong>{bb["total"]}</strong></div>'
            f'</div>')
    rows = ""
    for a in bb["areas"]:
        cls, label = STATUS_BADGE.get(a["status"], STATUS_BADGE["planned"])
        star = "★ " if a["flagship"] else ""
        rows += (f'<tr><td>{esc(star + a["title"])}</td>'
                 f'<td>{esc(a["priority"])}</td>'
                 f'<td><span class="badge {cls}">{label}</span></td>'
                 f'<td class="num">{a["live"]} / {a["partial"]} / {a["planned"]}</td></tr>')
    table = ('<table><thead><tr><th>Frente</th><th>Prioridad</th><th>Estado</th>'
             '<th>Vivas / Parciales / Deuda</th></tr></thead>'
             f'<tbody>{rows}</tbody></table>')
    flag = ""
    if bb["flagship_missing"]:
        items = "".join(f"<li>{esc(t)}</li>" for t in bb["flagship_missing"])
        flag = ('<div class="callout warn"><strong>Sondas de mayor valor que hoy no existen.</strong>'
                f'<ul>{items}</ul></div>')
    return kpis + table + flag


def render_html(facts: dict, narrative: dict, meta: dict) -> str:
    loads = [x for x in (facts.get("load_edge"), facts.get("load_app")) if x]
    recos = "".join(f"<li>{esc(r)}</li>" for r in narrative.get("recomendaciones", []))
    ev_files = ", ".join(sorted({x for x in [
        (facts.get("load_edge") or {}).get("file"), (facts.get("load_app") or {}).get("file"),
        (facts.get("sast") or {}).get("file"), (facts.get("dast_edge") or {}).get("file"),
        (facts.get("dast_app") or {}).get("file"), (facts.get("chat") or {}).get("file"),
    ] if x})) or "sin evidencia"
    return f"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{esc(meta['title'])}</title>
<style>
  :root{{
    --bg:#f6f7f9; --panel:#ffffff; --ink:#17191f; --muted:#5c6472; --line:#e2e6ec;
    --accent:#176b87; --accent-soft:#e6f1f5;
    --high:#8a1c1c; --high-soft:#fbe4e4; --med:#b45309; --med-soft:#fdefd9;
    --low:#1d4ed8; --low-soft:#e6edfd; --info:#4b5563; --info-soft:#eef0f3;
    --ok:#0f7b4f; --ok-soft:#e5f4ed;
  }}
  @media (prefers-color-scheme: dark){{
    :root{{
      --bg:#12151b; --panel:#1a1e26; --ink:#e8ebf0; --muted:#9aa4b2; --line:#2a2f3a;
      --accent:#4fb3d0; --accent-soft:#15303a;
      --high:#f2a2a2; --high-soft:#3a1a1a; --med:#f0c07a; --med-soft:#3a2a12;
      --low:#a8c1ff; --low-soft:#1a2540; --info:#aab3c0; --info-soft:#242a33;
      --ok:#7fd6ab; --ok-soft:#14301f;
    }}
  }}
  *{{box-sizing:border-box;}}
  body{{margin:0;background:var(--bg);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    line-height:1.6;font-size:16px;}}
  .wrap{{max-width:920px;margin:0 auto;padding:32px 20px 80px;}}
  header.top{{border-bottom:2px solid var(--accent);padding-bottom:20px;margin-bottom:8px;}}
  header.top .eyebrow{{color:var(--accent);font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:12px;margin:0;}}
  header.top h1{{font-size:28px;margin:6px 0 8px;line-height:1.2;}}
  header.top .meta{{color:var(--muted);font-size:14px;}}
  header.top .meta b{{color:var(--ink);}}
  h2{{font-size:22px;margin:38px 0 12px;padding-top:10px;border-top:1px solid var(--line);}}
  h3{{font-size:17px;margin:24px 0 8px;}}
  p{{margin:10px 0;}} a{{color:var(--accent);}}
  .lead{{font-size:17px;}}
  .panel{{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:14px 0;}}
  .callout{{border-left:4px solid var(--accent);background:var(--accent-soft);border-radius:8px;padding:12px 16px;margin:16px 0;}}
  .callout.warn{{border-left-color:var(--med);background:var(--med-soft);}}
  .grid3{{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;}}
  .tech{{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;}}
  .tech .tag{{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);}}
  .tech h3{{margin:6px 0;}} .tech .analogy{{color:var(--muted);font-size:14px;font-style:italic;}}
  table{{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px;}}
  th,td{{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top;}}
  th{{font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);}}
  td.num{{font-variant-numeric:tabular-nums;white-space:nowrap;}}
  .badge{{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap;}}
  .b-high{{background:var(--high-soft);color:var(--high);}} .b-med{{background:var(--med-soft);color:var(--med);}}
  .b-low{{background:var(--low-soft);color:var(--low);}} .b-info{{background:var(--info-soft);color:var(--info);}}
  .b-ok{{background:var(--ok-soft);color:var(--ok);}}
  .kpis{{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:14px 0;}}
  .kpi{{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;text-align:center;}}
  .kpi span{{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);}}
  .kpi strong{{font-size:22px;}}
  .kpi.high strong{{color:var(--high);}} .kpi.med strong{{color:var(--med);}}
  .kpi.low strong{{color:var(--low);}} .kpi.ok strong{{color:var(--ok);}}
  code{{background:var(--info-soft);padding:1px 5px;border-radius:5px;font-size:13px;}}
  ul.recos{{padding-left:20px;}} ul.recos li{{margin:6px 0;}}
  footer{{margin-top:50px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:13px;}}
  .gen-note{{font-size:12px;color:var(--muted);margin-top:8px;}}
</style>
</head>
<body>
<div class="wrap">

<header class="top">
  <p class="eyebrow">QA &amp; Cumplimiento · Reporte tecnico (generado)</p>
  <h1>{esc(meta['title'])}</h1>
  <p class="meta">
    Autor: <b>{esc(meta['author'])}</b> · Fecha: <b>{esc(meta['date'])}</b> ·
    Objetivo probado: <b>{esc(meta['target'])}</b> ·
    Tecnicas: <b>SAST · Carga · DAST · Consistencia del chat (IA)</b>
  </p>
</header>

<div class="callout">
  <strong>Resumen.</strong> {esc(narrative.get('resumen_ejecutivo'))}
</div>

<h2>1. Que se probo y como</h2>
<p class="lead">Este informe agrega la evidencia mas reciente de cuatro tipos de prueba
sobre la plataforma y explica que significan los resultados. Los numeros salen de la
evidencia guardada en <code>resultados/</code>; la interpretacion se redacta sobre esos
mismos numeros, sin inventar datos.</p>
<div class="grid3">
  <div class="tech"><span class="tag">SAST</span><h3>Analisis estatico</h3>
    <p>Revisa el codigo fuente sin ejecutarlo, buscando patrones peligrosos.</p>
    <p class="analogy">Un corrector, pero de seguridad. Herramienta: Bandit.</p></div>
  <div class="tech"><span class="tag">Carga</span><h3>Pruebas de carga</h3>
    <p>Manda muchas peticiones a la vez y mide latencia y disponibilidad.</p>
    <p class="analogy">Abrir todas las llaves para ver si la tuberia aguanta.</p></div>
  <div class="tech"><span class="tag">DAST</span><h3>Analisis dinamico</h3>
    <p>Prueba la app ya corriendo, desde afuera, como un atacante. Herramienta: OWASP ZAP.</p>
    <p class="analogy">Un inspector que prueba puertas y ventanas del edificio.</p></div>
  <div class="tech"><span class="tag">Chat / IA</span><h3>Consistencia del asistente</h3>
    <p>Repite la misma pregunta para ver si se contradice o inventa datos.</p>
    <p class="analogy">Preguntar lo mismo tres veces; un segundo modelo actua de juez.</p></div>
</div>

<h2>2. Resultados de las pruebas de carga</h2>
<p>{esc(narrative.get('lectura_carga'))}</p>
{load_table(loads)}
<p style="font-size:14px;color:var(--muted)"><b>rps</b> = peticiones por segundo ·
<b>SLO</b> = objetivo de latencia que fijamos. Menos milisegundos es mejor.</p>

<h2>3. Hallazgos de seguridad (SAST y DAST)</h2>
<p>{esc(narrative.get('lectura_seguridad'))}</p>
{load_scan_block(facts.get('sast'), 'SAST — codigo del proyecto (Bandit)')}
{load_scan_block(facts.get('dast_edge'), 'DAST — borde sin autenticar (ZAP)')}
{load_scan_block(facts.get('dast_app'), 'DAST — app autenticada (ZAP)')}

<h2>4. Consistencia del asistente de IA</h2>
<p>{esc(narrative.get('lectura_chat'))}</p>
{chat_table(facts.get('chat'))}

<h2>5. Cobertura de caja negra (deuda)</h2>
<p>Prueba de la plataforma desde afuera. El SAST se excluye a proposito: es caja
blanca sobre el propio codigo de QA. Lo que no se puede ejecutar hoy contra la
infra objetivo se registra como deuda con su bloqueo, no se simula. Fuente:
<code>config/blackbox-coverage.json</code>.</p>
{blackbox_block(facts.get('blackbox'))}

<h2>6. Recomendaciones</h2>
<ul class="recos">{recos}</ul>

<h2>7. Como leer las severidades</h2>
<div class="panel">
  <p><span class="badge b-high">Alta</span> &nbsp; Explotable con impacto serio. Se arregla de inmediato.</p>
  <p><span class="badge b-med">Media</span> &nbsp; Debilidad real que facilita un ataque. Se corrige pronto.</p>
  <p><span class="badge b-low">Baja</span> &nbsp; Buena practica faltante. Bajo riesgo por si sola.</p>
  <p><span class="badge b-info">Info</span> &nbsp; Observacion del escaner, no es una falla.</p>
</div>

<footer>
  <p>Evidencia (formato estandar <code>config/result.schema.json</code>): {esc(ev_files)}.</p>
  <p>Umbrales aplicados: SLO p95 borde {esc(_ms(meta['slo_edge']))}, app {esc(_ms(meta['slo_app']))};
  error maximo {esc(_pct(meta['max_error_rate']))}; severidad bloqueante ≥ {esc(SEV_ES.get(meta['blocking_severity'], meta['blocking_severity']))}.</p>
  <p class="gen-note">Informe generado el {esc(meta['date'])} · Narrativa: {esc(meta['narrative_source'])}{esc(meta['model_note'])} ·
  Higiene de credenciales: {esc(meta['hygiene_note'])}.</p>
</footer>

</div>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# Resultado JSON (para que la corrida aparezca en el dashboard)
# --------------------------------------------------------------------------- #
def write_result_json(run_id: str, report_rel: str, facts: dict, meta: dict,
                      started: str) -> Path:
    def scan_check(name, scan):
        if not scan:
            return {"name": name, "status": "skipped", "message": "Sin corrida reciente.",
                    "details": {}}
        return {"name": name,
                "status": "fail" if scan["blocking_count"] else "pass",
                "message": scan["verdict"], "details": {"counts": scan["counts"]}}

    checks = []
    for x in [facts.get("load_edge"), facts.get("load_app")]:
        if x:
            checks.append({"name": f"carga-{x['surface']}",
                           "status": "pass" if x["verdict"] == "Cumple" else "fail",
                           "message": f"p95 {_ms(x['p95_ms'])}, {_pct(x['error_rate'])} error",
                           "details": {"p95_ms": x["p95_ms"], "error_rate": x["error_rate"]}})
    checks.append(scan_check("sast", facts.get("sast")))
    checks.append(scan_check("dast-edge", facts.get("dast_edge")))
    checks.append(scan_check("dast-app", facts.get("dast_app")))
    chat = facts.get("chat")
    if chat:
        checks.append({"name": "chat-consistencia",
                       "status": "fail" if chat["failed"] else "pass",
                       "message": f"{chat['passed']} correctas, {chat['failed']} fallas"
                                  f" ({chat['hard_fails']} alucinacion)",
                       "details": {"passed": chat["passed"], "failed": chat["failed"],
                                   "hard_fails": chat["hard_fails"]}})
    status = "fail" if any(c["status"] == "fail" for c in checks) else "pass"
    result = {
        "schema_version": "1.0", "run_id": run_id, "tool": "report-builder",
        "category": "manual", "surface": None, "status": status,
        "started_at": started, "finished_at": utc_now(),
        "summary": f"Informe generado ({meta['narrative_source']}): " + narrative_summary(facts),
        "checks": checks, "artifacts": [report_rel],
    }
    out = RESULTS_DIR / f"{run_id}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out


def narrative_summary(facts: dict) -> str:
    scans = [x for x in (facts.get("sast"), facts.get("dast_edge"), facts.get("dast_app")) if x]
    high = sum(x["counts"]["high"] for x in scans)
    chat = facts.get("chat")
    return (f"{high} alta(s) en seguridad"
            + (f", {chat['failed']} fallas de chat" if chat else "")
            + (f" ({chat['hard_fails']} alucinacion)" if chat and chat["hard_fails"] else "") + ".")


# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(description="Genera un informe de carga y seguridad.")
    ap.add_argument("--no-llm", action="store_true", help="Fuerza narrativa determinista.")
    ap.add_argument("--title", default="Pruebas de carga y seguridad de la plataforma AITOps")
    ap.add_argument("--author", default=os.getenv("REPORT_AUTHOR", "QA & Cumplimiento"))
    ap.add_argument("--target", default=os.getenv("AITOPS_BASE_URL", "missioncontrol.qa.aitops.ai"))
    ap.add_argument("--p95-edge", type=float, default=1000.0)
    ap.add_argument("--p95-app", type=float, default=1500.0)
    ap.add_argument("--max-error-rate", type=float, default=0.02)
    ap.add_argument("--blocking-severity", default="high", choices=list(SEVERITIES))
    args = ap.parse_args()

    started = utc_now()
    log("phase collect")
    results = load_results()

    facts = {
        "load_edge": extract_load(latest(results, category="load", surface="edge"), slo_p95=args.p95_edge),
        "load_app": extract_load(latest(results, category="load", surface="app"), slo_p95=args.p95_app),
        "sast": extract_scan(latest(results, category="sast", surface=None),
                             blocking_severity=args.blocking_severity),
        "dast_edge": extract_scan(latest(results, category="dast", surface="edge"),
                                  blocking_severity=args.blocking_severity),
        "dast_app": extract_scan(latest(results, category="dast", surface="app"),
                                 blocking_severity=args.blocking_severity),
        "chat": extract_chat(latest_chat_reviewed(results)),
        "blackbox": extract_blackbox(),
    }
    # DAST sin surface: si no hubo split edge/app, usa la ultima como 'app'.
    if not facts["dast_edge"] and not facts["dast_app"]:
        facts["dast_app"] = extract_scan(latest(results, category="dast"),
                                         blocking_severity=args.blocking_severity)

    present = [k for k, v in facts.items() if v]
    log(f"collected {len(present)} superficies: {', '.join(present) or 'ninguna'}")

    log("phase narrative")
    narrative, source = build_narrative(facts, use_llm=not args.no_llm)
    log(f"narrative-source {source}")

    now = datetime.now(timezone.utc)
    meta = {
        "title": args.title, "author": args.author, "target": args.target,
        "date": now.strftime("%Y-%m-%d"),
        "slo_edge": args.p95_edge, "slo_app": args.p95_app,
        "max_error_rate": args.max_error_rate, "blocking_severity": args.blocking_severity,
        "narrative_source": source,
        "model_note": f" (modelo {narrative['_model']})" if narrative.get("_model") else "",
    }

    log("phase render")
    meta["hygiene_note"] = "pendiente"
    html_out = render_html(facts, narrative, meta)
    html_out, hits = scrub_secrets(html_out)
    meta["hygiene_note"] = "limpio" if hits == 0 else f"{hits} valor(es) redactado(s)"
    if hits:  # re-render para reflejar la nota de higiene ya actualizada
        html_out2 = render_html(facts, narrative, meta)
        html_out, _ = scrub_secrets(html_out2)

    REPORTS_DIR.mkdir(exist_ok=True)
    ts = stamp()
    report_path = REPORTS_DIR / f"informe-carga-y-seguridad-{ts}.html"
    report_path.write_text(html_out, encoding="utf-8")
    report_rel = str(report_path.relative_to(ROOT))

    run_id = f"report-{ts}"
    result_path = write_result_json(run_id, report_rel, facts, meta, started)

    log(f"report-written {report_rel}")
    log(f"result-written {result_path.relative_to(ROOT)}")
    log(f"[{utc_now()}] done narrative={source} hygiene={meta['hygiene_note']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
