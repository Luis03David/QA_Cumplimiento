#!/usr/bin/env python3
"""RAG golden-set evaluator for AITOps.

Runs the golden set through the REAL LibrarianLocalAgent and computes the
metrics the test plan proposes:

    recall@k, MRR@k, nDCG@k            (RET-2)
    score / rank stability             (RET-1, RRK-2)
    rerank uplift (nDCG con - sin)     (RRK-1)
    tenant leaks                       (MET-1)  -> BLOCKING
    hit/miss + suggest_tier2 accuracy  (RET-3)

Outputs a human report, a JSON report, and (optionally) pushes gauges to a
Prometheus Pushgateway so the numbers land in Grafana next to the online
Librarian metrics.

Usage:
    QDRANT_URL=... TEI_EMBED_BASE_URL=... TEI_RERANK_BASE_URL=... \
    python rag_eval.py --golden golden_set.yaml --json report.json \
        [--pushgateway http://pushgateway:9091] [--strict]

    python rag_eval.py --base-url http://ai_core_md_staging:8000 --preflight

    python rag_eval.py --base-url http://ai_core_md_staging:8000 \
        --json report.json --strict

--strict makes the process exit non-zero if any gate in meta.thresholds fails
(use it as the CI gate).

In HTTP mode (--base-url), rerank uplift is reported as null because the
external endpoint does not expose disable_rerank. That metric is skipped by
the strict gate in HTTP mode.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Protocol

import yaml

for candidate in ("/opt/git/aitops", "/opt/git/aitops-mdstg"):
    if (Path(candidate) / "app").is_dir() and candidate not in sys.path:
        sys.path.insert(0, candidate)


# ── relevance helpers ─────────────────────────────────────────────────────

DEFAULT_CONSULT_PATHS = (
    "/api/librarian/consult",
    "/librarian/consult",
    "/api/rag/consult",
    "/rag/consult",
    "/consult",
)


class ConsultClient(Protocol):
    supports_disable_rerank: bool

    def consult(self, **kwargs) -> dict:
        ...


class InProcessConsultClient:
    supports_disable_rerank = True

    def __init__(self, *, disable_rerank: bool = False):
        from app.agents.librarian.local_agent import LibrarianLocalAgent
        self.agent = LibrarianLocalAgent(disable_rerank=disable_rerank)

    def consult(self, **kwargs) -> dict:
        return self.agent.consult(**kwargs).to_dict()


class HttpConsultClient:
    supports_disable_rerank = False

    def __init__(
        self,
        base_url: str,
        *,
        consult_path: str | None = None,
        timeout: float = 20.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.consult_paths = (consult_path,) if consult_path else DEFAULT_CONSULT_PATHS
        self.timeout = timeout
        self._working_path: str | None = None

    def consult(self, **kwargs) -> dict:
        payload = {k: v for k, v in kwargs.items() if v is not None}
        data = json.dumps(payload).encode("utf-8")
        errors = []
        paths = (self._working_path,) if self._working_path else self.consult_paths
        for path in paths:
            url = f"{self.base_url}{path}"
            request = urllib.request.Request(
                url,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = response.read().decode("utf-8")
                parsed = json.loads(raw)
                self._working_path = path
                return _normalize_http_response(parsed)
            except urllib.error.HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")[:500]
                errors.append(f"{path}: HTTP {exc.code} {body}")
                if self._working_path:
                    break
            except Exception as exc:
                errors.append(f"{path}: {exc}")
                if self._working_path:
                    break
        raise RuntimeError("No usable consult endpoint. Tried: " + "; ".join(errors))


def _normalize_http_response(value: dict) -> dict:
    """Accept common API envelope shapes and return the consult payload."""
    if not isinstance(value, dict):
        raise TypeError(f"Expected JSON object, got {type(value).__name__}")
    for key in ("result", "data", "response"):
        inner = value.get(key)
        if isinstance(inner, dict) and (
            "snippets" in inner or "hit" in inner or "confidence" in inner
        ):
            value = inner
            break
    snippets = (
        value.get("snippets")
        or value.get("sources")
        or value.get("documents")
        or value.get("results")
        or []
    )
    normalized_snips = []
    for item in snippets:
        if not isinstance(item, dict):
            continue
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        normalized_snips.append({
            **item,
            "title": item.get("title") or item.get("source_id") or metadata.get("title") or metadata.get("source_id"),
            "text": item.get("text") or item.get("content") or item.get("snippet") or "",
            "score": float(item.get("score") or item.get("confidence") or 0.0),
            "tenant_id": item.get("tenant_id") or metadata.get("tenant_id"),
        })
    return {
        **value,
        "snippets": normalized_snips,
        "hit": bool(value.get("hit")) if "hit" in value else bool(normalized_snips),
        "confidence": float(value.get("confidence") or value.get("top_score") or (
            normalized_snips[0]["score"] if normalized_snips else 0.0
        )),
        "suggest_tier2": bool(value.get("suggest_tier2")) if "suggest_tier2" in value else False,
    }

def _snippet_matches(snip: dict, expect: dict) -> bool:
    """A returned snippet is relevant if its title is in relevant_sources OR
    its text contains one of the must_contain_any markers (case-insensitive)."""
    rel = set(expect.get("relevant_sources") or [])
    if rel and snip.get("title") in rel:
        return True
    markers = [m.lower() for m in (expect.get("must_contain_any") or [])]
    text = (snip.get("text") or "").lower()
    return any(m in text for m in markers)


def _grade(snip: dict, expect: dict) -> int:
    return int(expect.get("grade", 1)) if _snippet_matches(snip, expect) else 0


def _dcg(grades: list[int]) -> float:
    return sum(g / math.log2(i + 2) for i, g in enumerate(grades))


def _ndcg(snips: list[dict], expect: dict, k: int) -> float:
    grades = [_grade(s, expect) for s in snips[:k]]
    ideal = sorted(grades, reverse=True)
    idcg = _dcg(ideal)
    return (_dcg(grades) / idcg) if idcg > 0 else 0.0


def _first_relevant_rank(snips: list[dict], expect: dict) -> int | None:
    for i, s in enumerate(snips):
        if _snippet_matches(s, expect):
            return i + 1
    return None


def _kendall_tau(order_a: list[str], order_b: list[str]) -> float:
    """Kendall tau over the items common to both rankings. 1.0 = identical."""
    common = [x for x in order_a if x in set(order_b)]
    if len(common) < 2:
        return 1.0
    rank_b = {x: i for i, x in enumerate(order_b)}
    conc = disc = 0
    for i in range(len(common)):
        for j in range(i + 1, len(common)):
            a = 1 if i < j else -1
            b = 1 if rank_b[common[i]] < rank_b[common[j]] else -1
            if a == b:
                conc += 1
            else:
                disc += 1
    total = conc + disc
    return (conc - disc) / total if total else 1.0


# ── core evaluation ────────────────────────────────────────────────────────

def _snip_key(s: dict) -> str:
    return f"{s.get('title')}#{(s.get('text') or '')[:24]}"


def evaluate(golden: dict, client: ConsultClient, no_rerank_client: ConsultClient | None = None) -> dict:
    meta = golden.get("meta", {})
    k = int(meta.get("top_k", 5))
    ndcg_k = 10
    repeats = int(meta.get("determinism_repeats", 20))
    default_threshold = float(meta.get("threshold", 0.72))
    queries = golden["queries"]

    per_query: list[dict] = []
    recalls, rrs, ndcgs, ndcgs_no_rr = [], [], [], []
    tenant_leaks = 0
    hitmiss_correct = 0
    max_score_delta = 0.0
    min_tau = 1.0

    for q in queries:
        exp = q.get("expect", {})
        common = dict(query=q["query"], tenant_id=q["tenant_id"],
                      scope=q.get("scope", "all"), vendor=q.get("vendor"),
                      product=q.get("product"), top_k=k,
                      threshold=exp.get("min_confidence"))

        res = client.consult(**common)
        snips = res.get("snippets", [])

        # --- leak check (BLOCKING) ---
        leak_tenants = set(exp.get("leak_tenants") or [])
        forbidden = set(exp.get("forbidden_sources") or [])
        q_leaks = sum(
            1 for s in snips
            if (s.get("tenant_id") in leak_tenants) or (s.get("title") in forbidden)
        )
        tenant_leaks += q_leaks

        # --- hit/miss + tier2 correctness ---
        exp_hit = exp.get("hit")
        hit_ok = (exp_hit is None) or (res.get("hit") == exp_hit)
        tier2_ok = ("suggest_tier2" not in exp) or (
            res.get("suggest_tier2") == exp["suggest_tier2"])
        if hit_ok and tier2_ok:
            hitmiss_correct += 1

        # --- ranking metrics (only meaningful for positive queries) ---
        is_positive = bool(exp.get("relevant_sources") or exp.get("must_contain_any"))
        rank = _first_relevant_rank(snips, exp) if is_positive else None
        if is_positive:
            recalls.append(1.0 if (rank is not None and rank <= k) else 0.0)
            rrs.append(1.0 / rank if (rank and rank <= ndcg_k) else 0.0)
            ndcgs.append(_ndcg(snips, exp, ndcg_k))
            # rerank uplift baseline
            if no_rerank_client:
                res_no = no_rerank_client.consult(**common)
                ndcgs_no_rr.append(_ndcg(res_no.get("snippets", []), exp, ndcg_k))

        # --- determinism (score + order stability) ---
        base_scores = [round(s["score"], 6) for s in snips]
        base_order = [_snip_key(s) for s in snips]
        for _ in range(max(0, repeats - 1)):
            r = client.consult(**common)
            ss = r.get("snippets", [])
            for a, b in zip(base_scores, [s["score"] for s in ss]):
                max_score_delta = max(max_score_delta, abs(a - b))
            min_tau = min(min_tau, _kendall_tau(base_order, [_snip_key(s) for s in ss]))

        per_query.append({
            "id": q["id"], "hit": res.get("hit"), "confidence": res.get("confidence"),
            "rank": rank, "leaks": q_leaks, "hit_ok": hit_ok, "tier2_ok": tier2_ok,
            "suggest_tier2": res.get("suggest_tier2"),
        })

    def _avg(xs: list[float]) -> float:
        return sum(xs) / len(xs) if xs else 0.0

    summary = {
        "queries_total": len(queries),
        "positive_queries": len(recalls),
        "recall_at_5": round(_avg(recalls), 4),
        "mrr_at_10": round(_avg(rrs), 4),
        "ndcg_at_10": round(_avg(ndcgs), 4),
        "ndcg_at_10_no_rerank": round(_avg(ndcgs_no_rr), 4) if ndcgs_no_rr else None,
        "rerank_uplift_ndcg": round(_avg(ndcgs) - _avg(ndcgs_no_rr), 4) if ndcgs_no_rr else None,
        "score_stability_abs": round(max_score_delta, 6),
        "rank_stability_tau": round(min_tau, 4),
        "tenant_leaks_total": tenant_leaks,
        "hitmiss_accuracy": round(hitmiss_correct / len(queries), 4),
        "eval_timestamp": int(time.time()),
    }
    return {"summary": summary, "per_query": per_query, "meta": meta}


def check_gates(summary: dict, meta: dict) -> list[str]:
    t = meta.get("thresholds", {})
    fails = []
    def ge(name, key):
        if summary.get(name) is None:
            return
        if key in t and summary[name] < t[key]:
            fails.append(f"{name}={summary[name]} < {t[key]}")
    def le(name, key):
        if summary.get(name) is None:
            return
        if key in t and summary[name] > t[key]:
            fails.append(f"{name}={summary[name]} > {t[key]}")
    ge("recall_at_5", "recall_at_5")
    ge("mrr_at_10", "mrr_at_10")
    ge("ndcg_at_10", "ndcg_at_10")
    le("score_stability_abs", "score_stability_abs")
    ge("rank_stability_tau", "rank_stability_tau")
    ge("rerank_uplift_ndcg", "rerank_uplift_min")
    le("tenant_leaks_total", "tenant_leaks_max")
    return fails


def push_metrics(summary: dict, gateway: str) -> None:
    from prometheus_client import CollectorRegistry, Gauge, push_to_gateway
    reg = CollectorRegistry()
    for name, value in summary.items():
        if isinstance(value, (int, float)):
            g = Gauge(f"rag_golden_{name}", f"golden eval {name}", registry=reg)
            g.set(value)
    push_to_gateway(gateway, job="rag_golden_eval", registry=reg)


def make_clients(args: argparse.Namespace) -> tuple[ConsultClient, ConsultClient | None]:
    if args.base_url:
        return (
            HttpConsultClient(args.base_url, consult_path=args.consult_path, timeout=args.timeout),
            None,
        )
    return InProcessConsultClient(), InProcessConsultClient(disable_rerank=True)


def preflight(golden: dict, client: ConsultClient) -> int:
    """Fast check for network, seeded corpus, and expected retrieval.

    Exit codes:
      0 network + corpus + expected retrieval OK
      2 network OK but corpus appears empty/not seeded
      3 corpus returns snippets but not the expected document
      1 network/API error
    """
    query = next((q for q in golden["queries"] if q["id"] == "Q001"), golden["queries"][0])
    exp = query.get("expect", {})
    try:
        res = client.consult(
            query=query["query"],
            tenant_id=query["tenant_id"],
            scope=query.get("scope", "all"),
            vendor=query.get("vendor"),
            product=query.get("product"),
            top_k=int(golden.get("meta", {}).get("top_k", 5)),
            threshold=exp.get("min_confidence"),
        )
    except Exception as exc:
        print(f"PRE-FLIGHT FAIL: network/API error: {exc}", file=sys.stderr)
        return 1

    snips = res.get("snippets", [])
    if not snips:
        print("PRE-FLIGHT FAIL: network OK but no snippets returned; corpus likely not seeded.", file=sys.stderr)
        return 2
    if not any(_snippet_matches(s, exp) for s in snips):
        titles = [s.get("title") for s in snips]
        print(
            "PRE-FLIGHT FAIL: corpus returned snippets but not expected source. "
            f"Expected={exp.get('relevant_sources')} got={titles}",
            file=sys.stderr,
        )
        return 3
    print("PRE-FLIGHT PASS: network, corpus, and retrieval OK.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--golden", default=str(Path(__file__).parent / "golden_set.yaml"))
    ap.add_argument("--json", default=None)
    ap.add_argument("--pushgateway", default=None)
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--base-url", default=None, help="External AI Core base URL for HTTP mode.")
    ap.add_argument("--consult-path", default=None, help="Override consult endpoint path in HTTP mode.")
    ap.add_argument("--timeout", type=float, default=20.0, help="HTTP timeout in seconds.")
    ap.add_argument("--preflight", action="store_true", help="Run one fast network/corpus/retrieval check.")
    args = ap.parse_args()

    golden = yaml.safe_load(Path(args.golden).read_text(encoding="utf-8"))
    client, no_rerank_client = make_clients(args)
    if args.preflight:
        return preflight(golden, client)

    report = evaluate(golden, client, no_rerank_client)
    summary, meta = report["summary"], report["meta"]

    print("\n=== RAG golden-set eval ===")
    for k_, v in summary.items():
        print(f"  {k_:26s} {v}")

    fails = check_gates(summary, meta)
    print("\n  gates:", "PASS" if not fails else "FAIL")
    for f in fails:
        print(f"    - {f}")

    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\n  wrote {args.json}")
    if args.pushgateway:
        push_metrics(summary, args.pushgateway)
        print(f"  pushed metrics to {args.pushgateway}")

    return 1 if (args.strict and fails) else 0


if __name__ == "__main__":
    raise SystemExit(main())
