#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

mkdir -p resultados

overall=0

python3 scripts/run_dependency_audit.py || overall=1
python3 scripts/run_secret_scan.py || overall=1

exit "$overall"

