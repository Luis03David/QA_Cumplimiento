# Agentic evals CP-12 con DeepEval

Objetivo: convertir las pruebas ya ejecutadas de consistencia, jailbreak, RAG e inventario en una suite automatizable de evaluacion LLM.

## Que se evalua

| Tema CP-12 | Metricas | Oraculo principal |
| --- | --- | --- |
| Relevancia | `AnswerRelevancyMetric` + reglas `must_include` | La respuesta atiende el prompt sin salirse de scope |
| Faithfulness | `FaithfulnessMetric` + contexto esperado | La respuesta no contradice el contexto recuperado |
| Correctness | `GEval(name="Correctness")` + reglas | La salida coincide con el expected output |
| Hallucination | `HallucinationMetric` si existe, o G-Eval factuality + reglas | No inventa fuentes, owners, tickets, aprobadores, tools ni politicas |
| Toxicity | `ToxicityMetric` + listas de bloqueo | No amplifica insultos, abuso ni contenido discriminatorio |
| Bias/fairness | `BiasMetric` + pares contrafactuales | Misma decision para casos equivalentes con atributos sensibles cambiados |
| Prompt sensitivity | G-Eval + comparacion de decision/tool budget | Parafrasis, idioma, typos o presion no reducen controles |
| Latency | Medicion deterministica del runner | Cada caso conserva `latency_ms` y puede tener threshold |

DeepEval se usa como LLM-as-a-judge cuando esta instalado y hay un judge configurado. Las reglas deterministicas siempre corren y son el primer gate.

## Judge LLM

El runner soporta el mismo estilo OpenAI-compatible que usa `ethics_validator`:

- `DEEPEVAL_JUDGE_BASE_URL` o `ICS_LLM_API_URL` o `ETHICS_VLLM_API_BASE` o `VLLM_API_BASE`.
- `DEEPEVAL_JUDGE_MODEL` o `ICS_LLM_MODEL_NAME` o `ETHICS_MODEL_ID` o `ETHICS_VLLM_MODEL_ID` o `VLLM_MODEL_ID`.
- `DEEPEVAL_JUDGE_API_KEY` o `ICS_LLM_API_KEY` o `ETHICS_VLLM_API_KEY` o `VLLM_API_KEY` o `OPENAI_API_KEY`.
- `DEEPEVAL_JUDGE_EXTRA_BODY` o `ICS_LLM_EXTRA_BODY` para parametros especificos del backend vLLM/RunPod.
- Descubrimiento dinamico RunPod por nombre de pod con `DEEPEVAL_JUDGE_RUNPOD_POD_NAME` + `DEEPEVAL_JUDGE_RUNPOD_API_KEY`, o con los aliases `ICS_LLM_RUNPOD_POD_NAME` + `ICS_LLM_RUNPOD_API_KEY`.

Si duplicas el `.env` del agente `ethics`, usa `.env.local` en este repo y no lo commitees.

Por defecto el endpoint descubierto usa modo `proxy`: `http://<pod-id>-8000.proxy.runpod.net/v1`. Tambien soporta:

- `*_RUNPOD_ENDPOINT_MODE=internal` para `http://<pod-id>.runpod.internal:8000/v1`.
- `*_RUNPOD_ENDPOINT_MODE=public_tcp` para resolver `publicIp` y el mapeo de puerto.
- `*_RUNPOD_PORT`, `*_RUNPOD_PATH`, `*_RUNPOD_SCHEME` y `*_RUNPOD_API_BASE_URL`.

## Flujo automatizado

1. Ejecutar reglas deterministicas contra `tests/agentic/fixtures/cp12_agentic_eval_cases.json`.
2. Si `--use-deepeval` esta activo, ejecutar metricas DeepEval por caso.
3. Registrar `score`, `threshold`, `reason`, `latency_ms`, `eval_theme`, versiones y artifacts.
4. Exportar JSON compatible con `config/result.schema.json` en `resultados/agentic-evals-<timestamp>.json`.
5. Bloquear release si falla una regla critica, una metrica critica o si falta evidencia requerida.

## Comandos

Solo reglas:

```bash
python3 scripts/run_agentic_evals.py --rules-only
```

DeepEval opcional:

```bash
python3 -m pip install -r requirements-agentic-evals.txt
python3 scripts/run_agentic_evals.py --use-deepeval
```

Caso especifico:

```bash
python3 scripts/run_agentic_evals.py --case CP12-REG-001 --use-deepeval
```

## Fuentes usadas

DeepEval documenta que sus metricas son LLM-as-a-judge, que G-Eval permite criterios custom y que puede usar un modelo custom `DeepEvalBaseLLM`. Ver:

- https://deepeval.com/docs/metrics-introduction
- https://deepeval.com/docs/metrics-llm-evals
- https://deepeval.com/guides/guides-using-custom-llms
