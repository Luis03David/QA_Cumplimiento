# Formato de resultados

Todos los checks del proyecto deben escribir evidencia en `resultados/` como JSON compatible con `config/result.schema.json`.

Campos obligatorios:

- `schema_version`: version del contrato. Valor actual: `1.0`.
- `run_id`: identificador unico de ejecucion.
- `tool`: herramienta o script que genero el resultado.
- `category`: tipo de prueba (`e2e`, `load`, `dependency`, `secret`, `sast`, `compliance`, `manual`).
- `status`: resultado global (`pass`, `fail`, `skipped`).
- `started_at` y `finished_at`: timestamps UTC ISO 8601.
- `summary`: resumen humano breve.
- `checks`: lista de verificaciones individuales.
- `artifacts`: rutas de artefactos asociados, si existen.
- `metrics_summary`: resumen opcional por metrica agregada (`pass_rate`, scores y latencia promedio).

Reglas:

- `pass`: el check corrio y no encontro hallazgos bloqueantes.
- `fail`: el check corrio y encontro hallazgos, o habia una precondicion esperada que no se cumplio.
- `skipped`: el check no aplicaba al estado actual del repo, por ejemplo no hay manifiestos de dependencias.

Ejemplo:

```json
{
  "schema_version": "1.0",
  "run_id": "dependency-audit-20260703T190000Z",
  "tool": "dependency-audit",
  "category": "dependency",
  "status": "skipped",
  "started_at": "2026-07-03T19:00:00Z",
  "finished_at": "2026-07-03T19:00:01Z",
  "summary": "No dependency manifests found.",
  "checks": [
    {
      "name": "manifest-discovery",
      "status": "skipped",
      "message": "No supported dependency manifests found."
    }
  ],
  "artifacts": []
}
```
