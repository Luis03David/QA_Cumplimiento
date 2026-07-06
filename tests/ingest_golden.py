#!/usr/bin/env python3
"""Seed the RAG golden set into Qdrant (idempotent).

Reads every corpus/*.md, chunks it with the REAL Librarian chunker, embeds it
with the REAL TEI embedder, and upserts it into the REAL collections via the
Librarian indexer. Deterministic point IDs mean re-running just overwrites.

Run this ONCE against the isolated md-staging AI Core before rag_eval.py:

    QDRANT_URL=http://127.0.0.1:6333 \
    TEI_EMBED_BASE_URL=http://127.0.0.1:8001 \
    python ingest_golden.py

NEVER point this at prod (ai_core_v2 / shared Qdrant). Golden tenants are
`golden_a` / `golden_b`; vendor docs go to the global collection.

IMPORTANT: `title` is set to the corpus file stem (== source_id in the golden
set) so rag_eval.py can match snippets back to expected documents.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make the aitops package importable when this script runs standalone.
# Adjust if you drop the file under aitops/scripts/ (then imports just work).
for candidate in ("/opt/git/aitops", "/opt/git/aitops-mdstg"):
    if (Path(candidate) / "app").is_dir() and candidate not in sys.path:
        sys.path.insert(0, candidate)

from app.agents.librarian.ingest.chunker import chunk_text           # noqa: E402
from app.agents.librarian.ingest.embedder import TEIEmbeddingClient   # noqa: E402
from app.agents.librarian.ingest.indexer import (                     # noqa: E402
    ChunkPayload,
    GLOBAL_VENDOR_DOCS_COLLECTION,
    case_lessons_collection_for,
    compute_content_hash,
    kb_collection_for,
    now_epoch,
    upsert_chunks,
)

CORPUS_DIR = Path(__file__).parent / "corpus"


def _parse_header(text: str) -> dict:
    """Read the loose `key: value` header lines (vendor/product/... ) at the
    top of each corpus file. Values `null` / empty become None."""
    meta: dict[str, str | None] = {}
    for line in text.splitlines():
        s = line.strip()
        if ":" in s and not s.startswith("#") and not s.startswith("```"):
            k, _, v = s.partition(":")
            k = k.strip().lower()
            v = v.strip().strip('"')
            if k in {"vendor", "product", "version", "doc_type", "visibility", "tenant"}:
                meta[k] = None if v in ("", "null", "none") else v
    return meta


def _collection_and_tenant(meta: dict, stem: str) -> tuple[str, str, str]:
    """Return (collection, tenant_id_for_payload, source_type)."""
    visibility = meta.get("visibility") or "private"
    doc_type = meta.get("doc_type") or "vendor_doc"
    if visibility == "global":
        return GLOBAL_VENDOR_DOCS_COLLECTION, "global", "vendor_scrape"
    tenant = meta.get("tenant") or "golden_a"
    if doc_type == "case_lesson":
        return case_lessons_collection_for(tenant), tenant, "case_lesson"
    return kb_collection_for(tenant), tenant, "upload"


def main() -> int:
    embedder = TEIEmbeddingClient()
    files = sorted(CORPUS_DIR.glob("*.md"))
    if not files:
        print(f"No corpus files under {CORPUS_DIR}", file=sys.stderr)
        return 1

    grand_total = 0
    for path in files:
        stem = path.stem
        raw = path.read_text(encoding="utf-8")
        meta = _parse_header(raw)
        collection, tenant_id, source_type = _collection_and_tenant(meta, stem)
        visibility = meta.get("visibility") or "private"

        chunks = chunk_text(raw, max_tokens=1024, overlap_tokens=128)
        content_hash = compute_content_hash(raw)
        payload_chunks: list[tuple[str, ChunkPayload]] = []
        for ch in chunks:
            payload = ChunkPayload(
                tenant_id=tenant_id,
                visibility=visibility,
                source_type=source_type,
                source_id=stem,                 # stable id == golden source_id
                chunk_index=ch.index,
                chunk_total=len(chunks),
                content_hash=content_hash,
                scraped_at=now_epoch(),
                vendor=meta.get("vendor"),
                product=meta.get("product"),
                version=meta.get("version"),
                doc_type=meta.get("doc_type"),
                title=stem,                      # eval matches relevant_sources -> title
                language="en",
            )
            payload_chunks.append((ch.text, payload))

        n = upsert_chunks(collection, payload_chunks, embedder=embedder)
        grand_total += n
        print(f"  {stem:38s} -> {collection:34s} tenant={tenant_id:9s} chunks={n}")

    print(f"\nDone. {grand_total} chunks upserted across {len(files)} documents.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
