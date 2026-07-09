#!/usr/bin/env python3
"""Snapshot de cobertura de QA de caja negra.

Lee el catalogo vivo (config/blackbox-coverage.json), verifica contra la
evidencia real de resultados/ que los pilares declarados 'vivos/parciales'
tengan corridas, y emite un resultado en el formato estandar para que la
cobertura y la deuda aparezcan en el dashboard y en los informes.

No ejecuta las sondas contra la plataforma objetivo (muchas requieren infra,
credenciales o autorizacion que no viven en este repo); registra su estado y
bloqueo, igual que el proyecto ya hace con CP-01/CP-03 (skipped/faltante).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = ROOT / "resultados"
CATALOG = ROOT / "config" / "blackbox-coverage.json"

STATUS_TO_CHECK = {"live": "pass", "partial": "pass", "planned": "skipped"}


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def has_evidence(glob: str) -> int:
    if not glob:
        return 0
    return len([p for p in RESULTS_DIR.glob(glob) if ".raw" not in p.name and ".zap" not in p.name])


def main() -> int:
    started = utc_now()
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))

    checks = []

    # Pilares vivos: verificar que la evidencia declarada exista de verdad.
    for pillar in catalog.get("pillars", []):
        n = has_evidence(pillar.get("evidence_glob", ""))
        drift = pillar["status"] in ("live", "partial") and n == 0
        checks.append({
            "name": f"pilar:{pillar['id']}",
            "status": "fail" if drift else STATUS_TO_CHECK.get(pillar["status"], "skipped"),
            "message": (f"Pilar '{pillar['status']}' SIN evidencia en resultados/ (drift): "
                        f"{pillar['evidence_glob']}") if drift
            else f"{pillar['name']} — {pillar['status']} · {n} corrida(s) de evidencia.",
            "details": {"kind": "pillar", "status": pillar["status"], "evidence_runs": n,
                        "note": pillar.get("note", "")},
        })

    # Areas y sondas: registrar estado + bloqueo.
    area_counts = {}
    for area in catalog.get("areas", []):
        tally = {"live": 0, "partial": 0, "planned": 0}
        for probe in area.get("probes", []):
            st = probe.get("status", "planned")
            tally[st] = tally.get(st, 0) + 1
            checks.append({
                "name": f"{area['id']}:{probe['id']}",
                "status": STATUS_TO_CHECK.get(st, "skipped"),
                "message": (f"{probe['name']}" + (f" — bloqueo: {probe['blocker']}"
                            if st == "planned" and probe.get("blocker") else f" — {st}")),
                "details": {"kind": "probe", "area": area["id"], "status": st,
                            "priority": area.get("priority"), "flagship": area.get("flagship", False),
                            "blocker": probe.get("blocker", "")},
            })
        area_counts[area["id"]] = tally

    total_probes = sum(sum(t.values()) for t in area_counts.values())
    live = sum(t["live"] for t in area_counts.values())
    partial = sum(t["partial"] for t in area_counts.values())
    planned = sum(t["planned"] for t in area_counts.values())
    flagship_missing = [a["title"] for a in catalog.get("areas", [])
                        if a.get("flagship") and a.get("status") == "planned"]

    result = {
        "schema_version": "1.0",
        "run_id": f"blackbox-coverage-{stamp()}",
        "tool": "blackbox-coverage",
        "category": "manual",
        "surface": None,
        "status": "pass",
        "started_at": started,
        "finished_at": utc_now(),
        "summary": (f"Cobertura caja negra: {live} sonda(s) viva(s), {partial} parcial(es), "
                    f"{planned} en deuda de {total_probes}. "
                    + (f"Sondas estrella sin cobertura: {', '.join(flagship_missing)}."
                       if flagship_missing else "Sondas estrella cubiertas.")),
        "checks": checks,
        "artifacts": ["config/blackbox-coverage.json"],
    }

    RESULTS_DIR.mkdir(exist_ok=True)
    out = RESULTS_DIR / f"{result['run_id']}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(result["summary"])
    for area in catalog.get("areas", []):
        t = area_counts[area["id"]]
        print(f"  [{area.get('priority',''):8}] {area['title']}: "
              f"vivas {t['live']} · parciales {t['partial']} · deuda {t['planned']}")
    print(f"Escrito: {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
