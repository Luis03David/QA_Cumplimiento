"""Pytest gate for the RAG golden set (RET-2, RRK-1, MET-1, RET-3).

Drop this under aitops/tests/librarian/ (or run from the bundle). It requires
a live md-staging AI Core (Qdrant + TEI embed, optional reranker) with the
golden set already ingested via ingest_golden.py.

Skips automatically when the RAG endpoints are not reachable, so it never
breaks a laptop unit-test run. Wire it into CI where md-staging is available.

    pytest -m rag_golden tests/librarian/test_rag_golden_eval.py
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.rag_golden

GOLDEN = Path(__file__).with_name("golden_set.yaml")
if not GOLDEN.exists():
    GOLDEN = Path(__file__).parent / "fixtures" / "rag_golden" / "golden_set.yaml"


def _rag_available() -> bool:
    try:
        from app.agents.librarian.ingest.embedder import TEIEmbeddingClient
        return TEIEmbeddingClient().health()
    except Exception:
        return False


requires_rag = pytest.mark.skipif(
    not _rag_available(), reason="RAG endpoints not reachable (set TEI_EMBED_BASE_URL / QDRANT_URL)"
)


@pytest.fixture(scope="module")
def report():
    from rag_eval import evaluate  # bundle-local import; adjust for repo layout
    golden = yaml.safe_load(GOLDEN.read_text(encoding="utf-8"))
    return evaluate(golden)


@requires_rag
def test_no_tenant_leaks(report):
    """MET-1 — BLOCKING: zero cross-tenant snippets."""
    assert report["summary"]["tenant_leaks_total"] == 0, report["per_query"]


@requires_rag
def test_recall_at_5(report):
    thr = report["meta"]["thresholds"]["recall_at_5"]
    assert report["summary"]["recall_at_5"] >= thr


@requires_rag
def test_mrr_at_10(report):
    thr = report["meta"]["thresholds"]["mrr_at_10"]
    assert report["summary"]["mrr_at_10"] >= thr


@requires_rag
def test_ndcg_at_10(report):
    thr = report["meta"]["thresholds"]["ndcg_at_10"]
    assert report["summary"]["ndcg_at_10"] >= thr


@requires_rag
def test_rerank_does_not_regress(report):
    """RRK-1 — rerank must not lower nDCG vs dense-only."""
    thr = report["meta"]["thresholds"]["rerank_uplift_min"]
    assert report["summary"]["rerank_uplift_ndcg"] >= thr


@requires_rag
def test_determinism(report):
    thr = report["meta"]["thresholds"]
    assert report["summary"]["score_stability_abs"] <= thr["score_stability_abs"]
    assert report["summary"]["rank_stability_tau"] >= thr["rank_stability_tau"]


@requires_rag
def test_hitmiss_accuracy(report):
    """RET-3 — hit/miss + suggest_tier2 classification must be perfect."""
    assert report["summary"]["hitmiss_accuracy"] == 1.0, report["per_query"]
