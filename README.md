# QA Cumplimiento

Repositorio base para construir una funcion de Quality Engineering orientada a evidencia de cumplimiento. El proyecto arranca desde Fase 0: estructura minima, escaneo de dependencias, escaneo de secretos, contrato de resultados y una imagen Docker ejecutable.

## Alcance

- Cumplimiento internacional: GDPR e ISO/IEC 42001.
- Cumplimiento nacional pendiente de validacion legal: LFPDPPP Mexico.
- Cumplimiento EE.UU.: CCPA/CPRA.
- Infraestructura objetivo: self-hosted, con scheduler desacoplado de CI en nube.

Este repositorio estructura el trabajo tecnico de QA y cumplimiento. No sustituye asesoria legal.

## Estado Actual

- Fase 0 implementada.
- Repositorio Git configurado contra `https://github.com/Luis03David/QA_Cumplimiento.git`.
- Scripts locales de auditoria listos.
- Dockerfile funcional.
- GitHub Actions construye la imagen y ejecuta smoke test.
- Publicacion de imagen preparada para GHCR mediante ejecucion manual, pero desactivada por defecto.

## Estructura

```text
.
├── .github/workflows/       # Workflows de GitHub Actions
├── config/                  # Schemas y configuracion tecnica
├── docs/                    # Documentacion de soporte
├── resultados/              # Evidencia generada por ejecuciones
├── scripts/                 # Scripts operativos
├── tests/e2e/               # Pruebas E2E futuras
├── tests/load/              # Pruebas de carga futuras
├── tests/security/          # Pruebas de seguridad futuras
├── Dockerfile
├── plan.md
├── README.md
├── requirements.txt
└── RUNBOOK.md
```

## Inicio Rapido

Crear entorno local:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Ejecutar Fase 0:

```bash
scripts/run_phase0.sh
```

Construir y probar Docker:

```bash
docker build -t qa-cumplimiento:local .
docker run --rm qa-cumplimiento:local
```

## Resultados

Todos los checks deben escribir evidencia JSON en `resultados/`, siguiendo el contrato definido en:

- `config/result.schema.json`
- `docs/result-format.md`

Estados permitidos:

- `pass`: el check corrio y no encontro hallazgos bloqueantes.
- `fail`: el check encontro hallazgos o no pudo completarse correctamente.
- `skipped`: el check no aplica al estado actual del repo.

## Scripts Disponibles

```bash
scripts/run_dependency_audit.py
scripts/run_secret_scan.py
scripts/run_phase0.sh
```

`run_phase0.sh` ejecuta los checks base de dependencias y secretos.

## Docker

La imagen ejecuta Fase 0 por defecto:

```bash
docker run --rm qa-cumplimiento:local
```

El workflow `.github/workflows/docker-image.yml` construye la imagen en cada push o pull request contra `main`.

## GitHub Actions

Workflow principal:

- `.github/workflows/docker-image.yml`

Jobs:

- `build`: construye la imagen y ejecuta smoke test.
- `publish`: solo corre manualmente si `workflow_dispatch` recibe `push_image=true`.

Mientras no exista un registry definitivo, el flujo automatico no publica imagenes.

## Roadmap Tecnico

1. Fase 1: Playwright con CP-01 y CP-03.
2. Fase 2: suite completa CP-01 a CP-10 y SAST.
3. Fase 3: scheduler self-hosted con cron en contenedor.
4. Fase 4: pruebas de carga con k6 o Locust.
5. Fase 5: dashboard de cumplimiento.

El detalle completo vive en `plan.md`.
