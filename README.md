# QA Cumplimiento

Plataforma de **Quality Engineering orientada a evidencia de cumplimiento** para un asistente
conversacional de operaciones de TI (**AITOps**). Ejecuta pruebas sobre el asistente, guarda
evidencia auditable y comparable entre corridas, y la presenta en un dashboard.

El foco actual es la **superficie de Chat**: consistencia de respuestas, jailbreak, adversarial,
uso correcto de *tools* y una capa de **revisión inteligente con un LLM juez**.

---

## Los dos LLM del proyecto (no confundir)

| Rol | Qué es | Cómo se usa |
|-----|--------|-------------|
| **LLM bajo prueba** (el sujeto) | El asistente **AITOps** en `missioncontrol.qa.aitops.ai` (`/api/chat/v3/stream`), con *tools*. | Es lo que se evalúa. Los scripts le mandan prompts y capturan sus respuestas. |
| **LLM juez** (LLM-as-a-judge) | Modelo `Qwen` servido por **vLLM en RunPod**, endpoint compatible con OpenAI. | Apoyo opcional: puntúa/relee respuestas cuando una regla exacta no alcanza (evals + revisión inteligente). |

Filosofía (ver `plan.md`): **oráculos determinísticos primero, LLM juez solo como apoyo.**

---

## Arquitectura

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  Dashboard (Next.js, /app)  │        │  Asistente AITOps (externo)  │
│  - Catálogo único editable  │──HTTP──▶│  /api/chat/v3/stream (SSE)   │
│  - Lanzador de pruebas      │        └──────────────────────────────┘
│  - Reportes y corridas      │
│  - Revisión con el juez     │──HTTP──▶┌──────────────────────────────┐
└──────────────┬──────────────┘        │  LLM juez (Qwen / vLLM RunPod)│
               │                        └──────────────────────────────┘
      lee/escribe evidencia
               ▼
        resultados/*.json  ◀── scripts/ (captura, evals, revisión)
```

- **`app/`** — dashboard Next.js (App Router). APIs internas en `app/api/`.
- **`scripts/`** — captura de chat, evals (DeepEval/Ragas/promptfoo), microagente, revisión con juez.
- **`tests/`** — banco editable de casos (`chat_consistency_semantic_bank.json`), corpus, fixtures, e2e.
- **`resultados/`** — evidencia generada (JSON de resultado + `.raw.json` + `.log`).
- **`config/result.schema.json`** — contrato de los resultados.

---

## Requisitos

- **Node.js** 20+ (probado con v22) y npm.
- **Python** 3.12 (para scripts de evals y revisión).
- Acceso al ambiente QA de AITOps vía **Cloudflare Access**.
- Para el juez: credenciales de **RunPod** y del pod vLLM (se configuran en `.env`).

---

## Instalación

```bash
# 1) Dependencias de Node (dashboard + Playwright)
npm install
npm run e2e:install        # navegador Chromium para captura/e2e

# 2) Entorno Python (evals y revisión con el juez)
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
pip install -r requirements-agentic-evals.txt   # opcional: DeepEval
pip install -r requirements-ragas-evals.txt     # opcional: Ragas

# 3) Configuración
cp .env.example .env        # completa las variables (ver tabla abajo)
```

---

## Uso

### 1. Levantar el dashboard

```bash
npm run dev            # http://localhost:3000
```

Navegación por pestañas: **Resumen · Chat · Plataforma · Carga · Seguridad · Catálogos ·
Corridas · Hallazgos · Compliance · Configuración · Referencia**.

### 2. Autenticarse (Cloudflare Access)

Las pruebas de chat necesitan una sesión válida guardada en `.auth/aitops.json`:

```bash
npm run e2e:auth       # login asistido; también disponible en la pestaña "Configuración"
```

### 3. Editar el catálogo de casos

Pestaña **Catálogos**: un solo catálogo con todos los casos.

- Los casos del **banco** (`tests/chat_consistency_semantic_bank.json`) son **editables**: haz clic
  en una fila, ajusta prompt, familia (consistencia / jailbreak / adversarial) y criterios de
  aceptación, y **Guardar** (crea un backup `.bak` automático, ignorado por git).
- Los casos de **solo lectura** vienen de reportes HTML; se pueden **Importar al banco** para editarlos.

### 4. Lanzar pruebas de chat

Pestaña **Chat** → panel **Lanzar prueba**:

- Elige familia y casos, repeticiones y timeout, y **Lanzar prueba**.
- Verás en vivo: **barra de progreso (caso X de Y)**, tiempo transcurrido, OK/errores y el caso actual.
- Genera `resultados/chat-consistency-<ts>.json` + `.raw.json` + `.log`.

Por CLI directo:

```bash
node scripts/run_chat_consistency_capture.js
```

La captura evalúa con **reglas determinísticas** (hashes de respuesta normalizada, frases
`must_mention`/`must_not_mention`, reglas de tools, forma de respuesta). No usa el juez.

### 5. Revisión inteligente con el juez (LLM-as-a-judge)

Muchos `fail` mecánicos son falsos negativos: la respuesta varía en forma (opciones, pasos
cortos/largos) pero cumple la misma intención. El juez re-evalúa esos casos.

```bash
npm run judge:review                 # revisa la última corrida mecánica
npm run judge:review -- --run <id>   # revisa una corrida específica
```

O desde la UI: pestaña **Chat** → **Revisar con el juez (IA)**.

Reglas de la revisión:
- Solo re-evalúa casos `fail` que **sí obtuvieron respuesta** (pasaron la barrera de Cloudflare/Access).
- **Rescata** variación de forma aceptable → `pass`.
- **No anula** fallas de seguridad (frase prohibida, razonamiento interno visible, uso indebido de
  tools) ni respuestas ausentes.
- Produce `resultados/<id>-reviewed.json` + `.raw.json`, visibles en el selector de corridas con el
  veredicto y el motivo por caso.

### 6. Evals (opcional, con el juez)

```bash
npm run agentic:evals              # reglas determinísticas (default)
npm run agentic:evals:deepeval     # + DeepEval con el juez LLM
npm run ragas:evals                # métricas RAG
npm run promptfoo:eval
npm run evals:all                  # microagente: orquesta todos los gates
```

---

## Reportes y evidencia

- Pestaña **Chat**: veredicto rápido (pasó/falló, problema principal), métricas, hallazgos, y por caso
  la **pregunta, la respuesta, y en lenguaje sencillo por qué falló**. Incluye **selector de corrida**.
- Pestaña **Corridas**: historial completo de ejecuciones con filtros.
- Todos los resultados cumplen `config/result.schema.json` para ser auditables y comparables.

---

## Scripts npm

| Script | Descripción |
|--------|-------------|
| `dev` / `build` / `start` | Dashboard Next.js (desarrollo / build / producción). |
| `e2e:auth` | Login asistido de Cloudflare Access → `.auth/aitops.json`. |
| `e2e:install` | Instala Chromium para Playwright. |
| `e2e` / `e2e:report` / `test` | Pruebas E2E de plataforma. |
| `judge:review` | Revisión inteligente de una corrida de chat con el juez. |
| `agentic:evals` / `:deepeval` | Evals CP-12 (reglas / con juez DeepEval). |
| `ragas:evals` | Evals RAG (Ragas). |
| `promptfoo:eval` | Evals con promptfoo. |
| `evals:all` / `:deepeval` | Microagente que orquesta todos los gates. |

---

## Variables de entorno (`.env`)

| Variable | Para qué |
|----------|----------|
| `AITOPS_BASE_URL` | URL del asistente bajo prueba. |
| `AITOPS_*` (email, access client id/secret…) | Credenciales de Cloudflare Access. |
| `ICS_LLM_MODEL_NAME` / `ICS_LLM_API_KEY` | Modelo y llave del **juez**. |
| `ICS_LLM_RUNPOD_POD_NAME`, `ICS_RUNPOD_API_BASE_URL`, `RUNPOD_API_KEY` | Descubrimiento dinámico del pod vLLM del juez en RunPod. |
| `ICS_LLM_EXTRA_BODY` | Parámetros extra al juez (p. ej. `{"chat_template_kwargs":{"enable_thinking":false}}`). |
| `DEEPEVAL_JUDGE_*` | Alias equivalentes para configurar el juez de DeepEval. |

Alternativa: `DEEPEVAL_JUDGE_BASE_URL` / `DEEPEVAL_JUDGE_MODEL` para apuntar a un endpoint fijo sin
descubrimiento de RunPod. `.env` está en `.gitignore`; usa `.env.example` como plantilla.

---

## Notas importantes

- **Cloudflare y el juez:** el endpoint del juez está detrás de Cloudflare con protección de bots
  (Error 1010). Los clientes deben enviar un `User-Agent` permitido; los scripts del repo ya usan
  `qa-cumplimiento-agentic-evals/1.0`. Con `python-urllib` por defecto responde **403**.
- **Backups del catálogo:** cada guardado crea un `.bak` junto al banco; están en `.gitignore`.
- **`resultados/` está versionado:** la evidencia se commitea como parte del historial de calidad.

---

## Referencias

- `RUNBOOK.md` — corridas operativas, Docker, Git y release.
- `plan.md` — plan de pruebas por fases y casos de cumplimiento (CP-xx).
- `docs/` — análisis y notas: consistencia de chat, agentic evals, Ragas/promptfoo, formato de
  resultados, matriz de trazabilidad.
- `config/result.schema.json` — contrato de resultados.
