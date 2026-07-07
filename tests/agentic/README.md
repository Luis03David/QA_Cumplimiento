# CP-12 agentic eval fixtures

Este directorio contiene fixtures iniciales para evaluar riesgos CP-12:

- factualidad, faithfulness y alucinaciones;
- sesgo/fairness con pares contrafactuales;
- toxicidad;
- sensibilidad al prompt;
- regresion de safety;
- privacidad/cumplimiento;
- latencia.

Los casos iniciales combinan evidencia ya observada en los bancos de consistencia, reportes de jailbreak y casos sinteticos controlados. No incluyen PII real ni secretos.

Ejecucion local:

```bash
python3 scripts/run_agentic_evals.py --rules-only
```

Con DeepEval y un judge LLM OpenAI-compatible:

```bash
python3 -m pip install -r requirements-agentic-evals.txt
cp .env.example .env.local
# editar .env.local con DEEPEVAL_JUDGE_* o aliases ICS_LLM_*/ETHICS_*
python3 scripts/run_agentic_evals.py --use-deepeval
```

Si usas RunPod por nombre de pod, configura `DEEPEVAL_JUDGE_RUNPOD_POD_NAME` y `DEEPEVAL_JUDGE_RUNPOD_API_KEY`, o reutiliza `ICS_LLM_RUNPOD_POD_NAME` y `ICS_LLM_RUNPOD_API_KEY` del agente `ethics_validator`.
