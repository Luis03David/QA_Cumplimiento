# Microagente QA Calidad

`scripts/qa_quality_microagent.py` es un orquestador local para gates de calidad y cumplimiento.

## Que hace

- Verifica variables clave sin imprimir secretos.
- Confirma si existe sesion local `.auth/aitops.json`.
- Detecta si DeepEval esta instalado.
- Ejecuta CP-12 agentic evals con reglas deterministicas o con DeepEval opcional.
- Ejecuta RAGAS/RAG evals deterministas.
- Ejecuta agent workflow evals sobre la ultima traza de chat/tools.
- Genera config/evidencia Promptfoo para regresion de prompts.
- Resume el ultimo resultado de chat consistency.
- Valida artefactos generados contra `config/result.schema.json`.
- Escribe evidencia en `resultados/qa-quality-agent-<timestamp>.json`.

## Comandos

```bash
npm run qa:agent
```

Con DeepEval:

```bash
python3 -m pip install -r requirements-agentic-evals.txt
npm run qa:agent:deepeval
```

Capturar sesion antes de correr gates:

```bash
python3 scripts/qa_quality_microagent.py --capture-session
```

Ejecutar un caso CP-12 especifico:

```bash
python3 scripts/qa_quality_microagent.py --case CP12-REG-001
```

Saltar familias concretas:

```bash
python3 scripts/qa_quality_microagent.py --skip-ragas --skip-agent-workflows --skip-promptfoo
```

## Sesion

Si `.auth/aitops.json` existe y tiene `access_token`, el microagente no recaptura sesion. Si falla un flujo live o expira la sesion, corre:

```bash
npm run e2e:auth
```

El flujo puede pedir codigo Cloudflare si `AITOPS_ACCESS_CODE` no esta definido.
