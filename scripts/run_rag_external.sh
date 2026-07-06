#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BASE_URL="${BASE_URL:-http://ai_core_md_staging:8000}"
GOLDEN="${GOLDEN:-tests/golden_set.yaml}"
RESULTS_DIR="${RESULTS_DIR:-resultados}"
PUSHGATEWAY="${PUSHGATEWAY:-}"
CONSULT_PATH="${CONSULT_PATH:-}"
TIMEOUT="${TIMEOUT:-20}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/run_rag_external.sh [--base-url URL] [--golden FILE] [--pushgateway URL] [--consult-path PATH]

Environment defaults:
  BASE_URL=http://ai_core_md_staging:8000
  GOLDEN=tests/golden_set.yaml
  PUSHGATEWAY=
  CONSULT_PATH=
  TIMEOUT=20

Exit codes:
  0  preflight and strict eval passed
  1  network/API error, dependency error, or strict eval failed
  2  preflight reached AI Core but golden corpus appears unseeded
  3  preflight found corpus but did not retrieve the expected source
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="${2:-}"
      shift 2
      ;;
    --golden)
      GOLDEN="${2:-}"
      shift 2
      ;;
    --pushgateway)
      PUSHGATEWAY="${2:-}"
      shift 2
      ;;
    --consult-path)
      CONSULT_PATH="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BASE_URL" ]]; then
  echo "BASE_URL is required." >&2
  exit 1
fi

if [[ ! -f "$GOLDEN" ]]; then
  echo "Golden set not found: $GOLDEN" >&2
  exit 1
fi

mkdir -p "$RESULTS_DIR"
RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="$RESULTS_DIR/rag-golden-${RUN_TS}.raw.json"
RESULT="$RESULTS_DIR/rag-golden-${RUN_TS}.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

common_args=(
  --base-url "$BASE_URL"
  --golden "$GOLDEN"
  --timeout "$TIMEOUT"
)

if [[ -n "$CONSULT_PATH" ]]; then
  common_args+=(--consult-path "$CONSULT_PATH")
fi

echo "Preflight: $BASE_URL"
python3 tests/rag_eval.py "${common_args[@]}" --preflight
preflight_status=$?

case "$preflight_status" in
  0)
    ;;
  2)
    echo "Preflight reached AI Core, but the golden corpus appears unseeded. Run tests/ingest_golden.py from md-staging first." >&2
    exit 2
    ;;
  3)
    echo "Preflight found snippets, but not the expected golden source. Check tenant/scope/index contents." >&2
    exit 3
    ;;
  *)
    echo "Preflight failed with exit code $preflight_status." >&2
    exit 1
    ;;
esac

eval_args=("${common_args[@]}" --json "$REPORT" --strict)
if [[ -n "$PUSHGATEWAY" ]]; then
  eval_args+=(--pushgateway "$PUSHGATEWAY")
fi

echo "Running strict golden eval..."
python3 tests/rag_eval.py "${eval_args[@]}"
eval_status=$?
FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ -f "$REPORT" ]]; then
  RAW_REPORT="$REPORT" RESULT_JSON="$RESULT" RUN_TS="$RUN_TS" STARTED_AT="$STARTED_AT" FINISHED_AT="$FINISHED_AT" EVAL_STATUS="$eval_status" python3 - <<'PY'
import json
import os
from pathlib import Path

raw_path = Path(os.environ["RAW_REPORT"])
result_path = Path(os.environ["RESULT_JSON"])
run_ts = os.environ["RUN_TS"]
started_at = os.environ["STARTED_AT"]
finished_at = os.environ["FINISHED_AT"]
eval_status = int(os.environ["EVAL_STATUS"])

report = json.loads(raw_path.read_text(encoding="utf-8"))
summary = report.get("summary", {})
thresholds = report.get("meta", {}).get("thresholds", {})

def metric_check(name, comparator, threshold_key, label=None):
    label = label or name
    value = summary.get(name)
    if value is None:
        return {
            "name": label,
            "status": "skipped",
            "message": f"{name} no disponible para este modo de ejecucion.",
            "details": {"metric": name, "value": value, "threshold": thresholds.get(threshold_key)},
        }
    threshold = thresholds.get(threshold_key)
    ok = True if threshold is None else comparator(value, threshold)
    return {
        "name": label,
        "status": "pass" if ok else "fail",
        "message": f"{name}={value}; threshold={threshold}",
        "details": {"metric": name, "value": value, "threshold": threshold},
    }

checks = [
    metric_check("recall_at_5", lambda v, t: v >= t, "recall_at_5", "RET-2 recall@5"),
    metric_check("mrr_at_10", lambda v, t: v >= t, "mrr_at_10", "RET-2 MRR@10"),
    metric_check("ndcg_at_10", lambda v, t: v >= t, "ndcg_at_10", "RET-2 nDCG@10"),
    metric_check("score_stability_abs", lambda v, t: v <= t, "score_stability_abs", "RET-1 score stability"),
    metric_check("rank_stability_tau", lambda v, t: v >= t, "rank_stability_tau", "RET-1 rank stability"),
    metric_check("rerank_uplift_ndcg", lambda v, t: v >= t, "rerank_uplift_min", "RRK-1 rerank uplift"),
    metric_check("tenant_leaks_total", lambda v, t: v <= t, "tenant_leaks_max", "MET-1 tenant isolation"),
]

hitmiss = summary.get("hitmiss_accuracy")
checks.append({
    "name": "RET-3 hit/miss accuracy",
    "status": "pass" if hitmiss == 1.0 else "fail",
    "message": f"hitmiss_accuracy={hitmiss}; threshold=1.0",
    "details": {"metric": "hitmiss_accuracy", "value": hitmiss, "threshold": 1.0},
})

status = "fail" if eval_status != 0 or any(c["status"] == "fail" for c in checks) else "pass"
result = {
    "schema_version": "1.0",
    "run_id": f"rag-golden-{run_ts}",
    "tool": "rag-golden-eval",
    "category": "compliance",
    "status": status,
    "started_at": started_at,
    "finished_at": finished_at,
    "summary": "RAG golden eval completado." if status == "pass" else "RAG golden eval encontro fallas de gate.",
    "checks": checks,
    "artifacts": [str(raw_path)],
}
result_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(f"wrote {result_path}")
PY
fi

if [[ "$eval_status" -eq 0 ]]; then
  echo "PASS: wrote $REPORT and $RESULT"
else
  echo "FAIL: strict eval failed; reports at $REPORT and $RESULT" >&2
fi

exit "$eval_status"
