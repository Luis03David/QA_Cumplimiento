# RAGAS, agent evals y Promptfoo

Este repo ahora cubre los bloques sin voz:

- DeepEval para CP-12 LLM evals.
- RAGAS-style evals para RAG.
- Agent workflow evals sobre trazas reales de chat/tools.
- Promptfoo para regresion de prompts y safety.

## RAGAS

Runner:

```bash
python3 scripts/run_ragas_evals.py
```

Metricas cubiertas:

- `faithfulness`
- `context_precision`
- `context_recall`
- `answer_relevancy`

El modo actual usa gates deterministas sobre fixtures controlados. Para usar RAGAS real:

```bash
python3 -m pip install -r requirements-ragas-evals.txt
python3 scripts/run_ragas_evals.py --use-ragas
```

## Agent evals

Runner:

```bash
python3 scripts/run_agent_workflow_evals.py
```

Metricas:

- `task_completion`
- `tool_correctness`
- `argument_correctness`
- `turn_relevancy`
- `conversation_completeness`

Usa la ultima traza `chat-consistency-*-reviewed.raw.json` cuando existe.

## Promptfoo

Runner:

```bash
python3 scripts/run_promptfoo_eval.py
```

Genera una config Promptfoo en `resultados/promptfooconfig-<timestamp>.yaml` cuando `PyYAML` esta disponible; si no, usa `.json`. La config se arma desde los fixtures CP-12. Si `promptfoo` esta instalado, tambien intenta ejecutar el eval.

Variables relevantes:

- `ICS_LLM_MODEL_NAME`
- `ICS_LLM_API_KEY`
- `ICS_LLM_RUNPOD_POD_NAME`
- `RUNPOD_API_KEY`
- `PROMPTFOO_OPENAI_BASE_URL` si quieres saltarte discovery RunPod.
