# Golden set RAG AITOps — bundle — DG — 2026-07-06

Bundle **auto-contenido y reproducible** para evaluar la consistencia del RAG
(retrieval, reranking, chunking, metadata) del [plan de pruebas](../rag-chat-plan-pruebas-consistencia-DG-2026-07-06.md).
No modifica el repo: son ficheros listos para copiar a `aitops/`.

## Contenido

| Archivo | Qué es |
|---|---|
| `golden_set.yaml` | 17 queries con esperado (hit/miss, fuentes relevantes, marcadores, filtros, aislamiento). Incluye umbrales de aceptación. |
| `corpus/*.md` | 8 documentos semilla (vendor docs globales + KB privado de `golden_a` + case-lesson). Con header `vendor/product/visibility/tenant`. |
| `ingest_golden.py` | Chunkea + embebe + upserta el corpus a Qdrant usando el chunker/embedder/indexer **reales**. Idempotente. |
| `rag_eval.py` | Calcula recall@5, MRR@10, nDCG@10, estabilidad, uplift de rerank y fugas de tenant. Escribe JSON y puede empujar a Pushgateway. |
| `test_rag_golden_eval.py` | Gate de `pytest` (skippea si no hay RAG en vivo). |

## Diseño clave

- **Relevancia robusta a chunking:** una query "acierta" si un snippet del top-k
  tiene `title == source_id` (el ingester pone `title = nombre de archivo`) **o**
  su texto contiene un `must_contain_any`. Así el recall no se rompe cuando
  cambian las fronteras de chunk (por eso sirve para CHK/RET a la vez).
- **Aislamiento (MET-1) es bloqueante:** Q011/Q012 verifican 0 snippets de otro
  tenant y 0 fuentes prohibidas. Cualquier fuga → gate rojo.
- **Miss legítimo (RET-3):** Q013/Q014 esperan `hit=false` + `suggest_tier2=true`.
- **Uplift de rerank (RRK-1):** cada query positiva se corre con y sin reranker
  (`disable_rerank=True`) y se compara nDCG.

## Cómo correr (solo en md-staging, NUNCA prod)

```bash
# 1. Apuntar a la infra AISLADA de staging (ver CLAUDE.md §10)
export QDRANT_URL=http://127.0.0.1:6333
export TEI_EMBED_BASE_URL=http://127.0.0.1:8001
export TEI_RERANK_BASE_URL=http://127.0.0.1:8002   # opcional

# 2. Sembrar el corpus (una vez; idempotente)
python ingest_golden.py

# 3. Evaluar + gate CI + métricas a Grafana
python rag_eval.py --json report.json \
    --pushgateway http://pushgateway:9091 --strict
```

`--strict` sale con código ≠0 si falla algún umbral → úsalo como gate de CI.

## Cómo correr desde un entorno externo

Si el runner externo tiene red al AI Core de md-staging pero no puede importar
el paquete Python interno de AITOps, usa el modo HTTP:

```bash
pip install pyyaml prometheus_client
python tests/rag_eval.py --base-url http://ai_core_md_staging:8000 --preflight
python tests/rag_eval.py --base-url http://ai_core_md_staging:8000 \
  --json resultados/rag-golden-report.raw.json --strict
```

Preflight:

- `0`: red, corpus y retrieval OK.
- `2`: red OK, pero corpus golden no sembrado.
- `3`: corpus presente, pero no recupera el documento esperado.

Wrapper para pipeline externo:

```bash
scripts/run_rag_external.sh \
  --base-url http://ai_core_md_staging:8000 \
  --pushgateway http://pushgateway:9091
```

Notas:

- `--base-url` debe apuntar a `ai_core_md_staging`, nunca a `ai_core_v2` de prod.
- En modo HTTP, `rerank_uplift_ndcg` queda `null` porque el endpoint externo no
  expone `disable_rerank`; no cuenta como fallo del gate.
- Si el path real del endpoint difiere, usa `--consult-path /ruta/real`.

## Dónde colocarlo en el repo (cuando haya plan aprobado)

```
aitops/tests/fixtures/rag_golden/golden_set.yaml
aitops/tests/fixtures/rag_golden/corpus/*.md
aitops/scripts/rag_eval.py           (+ ingest_golden.py)
aitops/tests/librarian/test_rag_golden_eval.py
```

Registrar el marker en `pytest.ini`: `markers = rag_golden: needs live md-staging RAG`.

## Extender el golden set

1. Añade el `.md` a `corpus/` con su header (`visibility: global` para vendor,
   `tenant: golden_a` + `visibility: private` para KB).
2. Añade queries a `golden_set.yaml` con `relevant_sources` = stem del archivo y
   `must_contain_any` = 2–3 marcadores literales del contenido.
3. Re-corre `ingest_golden.py` y `rag_eval.py`.

> Los umbrales (recall≥0.85, etc.) son una **propuesta**. Calíbralos con la
> primera corrida real antes de fijarlos como gate.
