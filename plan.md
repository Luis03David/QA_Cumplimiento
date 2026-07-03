# Plan de Arranque - Proyecto QA & Cumplimiento

Version: 1.0
Fecha: 2026-07-03
Alcance: Quality Engineering desde cero, self-hosted, con foco en evidencia objetiva de cumplimiento.

## Objetivo

Construir por fases una funcion de Quality Engineering que permita ejecutar pruebas repetibles, guardar evidencia objetiva y mapear resultados contra controles tecnicos y requisitos de cumplimiento.

El orden rector es:

1. Primero los tests corren manualmente.
2. Despues se automatizan.
3. Luego se programan en infraestructura self-hosted.
4. Al final se visualizan en dashboard.

## Fase 0 - Fundamentos

Objetivo: dejar lista la base minima para trabajar.

Entregables:

- Repositorio Git inicializado.
- Estructura base:
  - `tests/e2e/`
  - `tests/load/`
  - `tests/security/`
  - `config/`
  - `resultados/`
  - `docs/`
  - `scripts/`
- Formato estandar de resultados en JSON.
- Script de escaneo de dependencias.
- Script de escaneo de secretos.
- Evidencia inicial generada en `resultados/`.

Criterio de listo: los escaneos corren localmente, generan resultados con timestamp y dejan claro si pasaron, fallaron o fueron omitidos por falta de manifiestos/herramientas.

## Fase 1 - Primeros tests E2E criticos

Objetivo: implementar los flujos de mayor exposicion legal.

Entregables:

- Configuracion de Playwright.
- Test CP-01: borrado de datos.
- Test CP-03: DSAR/access.
- Resultados exportados al formato estandar.

Criterio de listo: CP-01 y CP-03 pasan de forma reproducible localmente y guardan evidencia.

## Fase 2 - Suite completa + SAST

Objetivo: cubrir todos los casos CP-01 a CP-10 y sumar analisis estatico.

Entregables:

- Tests Playwright para CP-02 y CP-04 a CP-10.
- Integracion de SAST, por ejemplo Semgrep o Bandit segun el stack final.
- Consolidacion de resultados en `resultados/`.

Criterio de listo: los 10 casos existen como tests ejecutables y SAST reporta hallazgos en el mismo formato.

## Fase 3 - Automatizacion y scheduler self-hosted

Objetivo: ejecutar pruebas sin intervencion manual.

Entregables:

- Contenedor con cron para disparar pruebas.
- Frecuencias definidas:
  - E2E nocturno.
  - Dependencias y secretos en cada cambio o ejecucion programada.
  - Carga segun criticidad.
- Politica de retencion de evidencia.

Criterio de listo: los jobs corren en horario definido y dejan resultados historicos consultables.

## Fase 4 - Pruebas de carga configurables

Objetivo: medir disponibilidad y defensas bajo carga.

Entregables:

- k6 o Locust configurado.
- CP-05 implementado con usuarios virtuales y duracion parametrizables.
- Resultados integrados al almacen de evidencia.

Criterio de listo: la prueba de carga corre con parametros configurables y guarda resultados junto con el resto.

## Fase 5 - Dashboard de cumplimiento

Objetivo: visualizar el estado de calidad y cumplimiento.

Entregables:

- App ligera que lee resultados, no ejecuta tests.
- Estado por estandar y jurisdiccion.
- Matriz de trazabilidad viva.
- Historico de ejecuciones.
- Panel de configuracion de pruebas.

Criterio de listo: el dashboard lee resultados reales y muestra cobertura por LFPDPPP, CCPA/CPRA, GDPR e ISO/IEC 42001.

## Cobertura inicial por jurisdiccion

| Jurisdiccion | Marco | Casos asociados |
| --- | --- | --- |
| Internacional | GDPR | CP-01, CP-03, CP-07, CP-08 |
| Internacional | ISO/IEC 42001 | CP-09, CP-10 |
| EE.UU. | CCPA/CPRA | CP-01, CP-02, CP-08 |
| Mexico | LFPDPPP | Pendiente de validacion legal y mapeo ARCO |

Nota: el mapeo legal debe validarse con un aprobador legal antes de considerar cerrado el alcance MX/US. Este plan estructura el trabajo tecnico y no sustituye asesoria legal.

## Evidencia minima exigible

- Resultado de cada ejecucion con timestamp.
- Estado `pass`, `fail` o `skipped`.
- Logs o artefactos asociados cuando existan.
- Matriz de trazabilidad requisito legal -> control tecnico -> caso de prueba -> evidencia.
- Muestras de exportacion, borrado o auditoria cuando apliquen los CP funcionales.

## Riesgos principales

| Riesgo | Impacto | Mitigacion |
| --- | --- | --- |
| Construir dashboard antes que tests | Alto | Respetar fases; dashboard en Fase 5 |
| Tests que nadie ejecuta | Alto | Automatizar en Fase 3 |
| Requisitos legales asumidos | Alto | Validacion legal antes de Fase 5 |
| Cobertura ilusoria | Medio | Criterios de pase/fallo revisados por QA Lead |
| Alcance sin control | Medio | Cerrar cada fase con criterio de listo |

## Ejecucion inicial

Accion inmediata: ejecutar Fase 0 en este workspace.

Estado esperado al cierre de esta primera ejecucion:

- `plan.md` creado.
- Repositorio Git inicializado.
- Estructura base creada.
- `config/result.schema.json` definido.
- Scripts de escaneo creados.
- Ejecucion local de Fase 0 realizada y evidenciada en `resultados/`.

Estado real de ejecucion:

- Repositorio Git inicializado en `/cum`.
- Estructura base creada.
- Formato estandar definido en `config/result.schema.json`.
- Documentacion del formato creada en `docs/result-format.md`.
- Matriz inicial creada en `docs/traceability.md`.
- Escaneo de dependencias ejecutado:
  - Evidencia: `resultados/dependency-audit-20260703T193457Z.json`.
  - Estado: `pass`.
  - Nota: `requirements.txt` existe y fue auditado con `pip-audit`.
- Escaneo de secretos ejecutado:
  - Evidencia: `resultados/secret-scan-20260703T193522Z.json`.
  - Estado: `pass`.
  - Nota: se uso scanner regex fallback porque `gitleaks` y `trufflehog` no estan instalados.
- Git remoto configurado:
  - `origin`: `https://github.com/Luis03David/QA_Cumplimiento.git`.
- Imagen Docker validada localmente:
  - Tag local: `qa-cumplimiento:local`.
  - Smoke test: `docker run --rm qa-cumplimiento:local`.
