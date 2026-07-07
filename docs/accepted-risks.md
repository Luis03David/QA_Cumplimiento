# Riesgos aceptados — auditoría de dependencias

Este documento registra las vulnerabilidades de dependencias que se aceptan como
**riesgo documentado** y por tanto no bloquean la Fase 0 (`scripts/run_dependency_audit.py`).

La lista efectiva vive en [`config/dependency-audit-ignore.json`](../config/dependency-audit-ignore.json);
el script la pasa a `pip-audit --ignore-vuln`. Cada entrada debe tener justificación y revisarse
periódicamente.

## Vigentes

| CVE | Paquete | Origen | Motivo de aceptación | Revisar |
|-----|---------|--------|----------------------|---------|
| CVE-2026-6587 | ragas | directa (`requirements-ragas-evals.txt`) | Sin parche upstream. Solo se usa en el stack **opcional** de evals, no en el producto ni el dashboard. | Cuando ragas publique fix |
| CVE-2025-69872 | diskcache | transitiva de ragas | Sin parche upstream. Llega solo por ragas (evals). | Cuando diskcache/ragas publiquen fix |

## Cómo agregar o quitar un riesgo aceptado

1. Edita `config/dependency-audit-ignore.json` (añade `{ "id", "package", "reason" }` o quítalo).
2. Actualiza la tabla de arriba.
3. Vuelve a correr `npm run evals:all` o `bash scripts/run_phase0.sh` y confirma el resultado.

## Notas

- Aceptar un riesgo **no** lo elimina: sigue apareciendo en el raw de pip-audit; solo deja de
  marcar `fail` el gate. La evidencia queda en `resultados/`.
- Las vulnerabilidades **con** fix disponible NO deben ir aquí: se resuelven subiendo la versión.
