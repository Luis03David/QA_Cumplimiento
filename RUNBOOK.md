# Runbook Operativo

Este runbook documenta las corridas habituales del proyecto: preparacion local, checks, Docker, Git, release y GitHub Actions.

## Prerrequisitos

- Git.
- Python 3.12 o compatible.
- Docker.
- Acceso al remoto `https://github.com/Luis03David/QA_Cumplimiento.git`.
- Acceso al repositorio Docker Hub `luis03david/qa_cumplimiento`.
- Opcional: GitHub CLI (`gh`) para crear releases desde terminal.

## Preparar Entorno Local

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Validar scripts:

```bash
python3 -m py_compile scripts/run_dependency_audit.py scripts/run_secret_scan.py
```

## Ejecutar Fase 0

```bash
scripts/run_phase0.sh
```

El script usa `.venv/bin/python` automaticamente si existe. Tambien se puede forzar un interprete:

```bash
PYTHON=.venv/bin/python scripts/run_phase0.sh
```

Salida esperada:

- Un JSON de auditoria de dependencias en `resultados/`.
- Un JSON de escaneo de secretos en `resultados/`.
- Codigo de salida `0` si no hay fallos bloqueantes.

## Ejecutar Checks Individuales

Dependencias:

```bash
python3 scripts/run_dependency_audit.py
```

Secretos:

```bash
python3 scripts/run_secret_scan.py
```

## Validar Evidencia

Validar sintaxis JSON:

```bash
python3 -m json.tool config/result.schema.json >/dev/null
for f in resultados/*.json; do python3 -m json.tool "$f" >/dev/null; done
```

Validar resultados contra schema si `jsonschema` esta instalado:

```bash
python3 - <<'PY'
import json
from pathlib import Path
import jsonschema

schema = json.loads(Path("config/result.schema.json").read_text())
for path in sorted(Path("resultados").glob("*.json")):
    if path.name.endswith(".raw.json") or "fallback-findings" in path.name:
        continue
    jsonschema.validate(json.loads(path.read_text()), schema)
    print(f"schema-ok {path}")
PY
```

## Docker

Construir imagen local:

```bash
docker build -t qa-cumplimiento:local .
```

Ejecutar smoke test:

```bash
docker run --rm qa-cumplimiento:local
```

Inspeccionar imagen:

```bash
docker image inspect qa-cumplimiento:local --format '{{.Id}} {{.Size}}'
```

Publicar manualmente en Docker Hub desde local:

```bash
docker login
docker tag qa-cumplimiento:local luis03david/qa_cumplimiento:tagname
docker push luis03david/qa_cumplimiento:tagname
```

Recomendacion: usar un access token de Docker Hub en `docker login`, no la password de la cuenta.

## Git Basico

Ver remoto:

```bash
git remote -v
```

Ver estado:

```bash
git status --short --branch
```

Crear commit:

```bash
git add .
git commit -m "Describe el cambio"
```

Probar push sin publicar:

```bash
git push --dry-run origin main
```

Publicar rama principal:

```bash
git push -u origin main
```

## Release con Git

El repo incluye un wrapper en raiz:

```bash
./git-release.sh --dry-run
```

Comportamiento:

- Si no pasas version, calcula el siguiente semver desde el ultimo tag `vX.Y.Z`.
- Por defecto detecta el tipo de cambio desde commits convencionales:
  - `feat:` sube minor.
  - `fix:` y cambios normales suben patch.
  - `feat!:` o `BREAKING CHANGE` suben major.
- Si no existe ningun tag semver, propone `v0.1.0`.
- En modo real exige working tree limpio y branch `main` sincronizado con `origin/main`.
- Con `--dry-run` no crea tags ni publica nada.

Crear release versionado con el script:

```bash
./git-release.sh --yes
```

Forzar tipo de incremento:

```bash
./git-release.sh --patch --yes
./git-release.sh --minor --yes
./git-release.sh --major --yes
```

Forzar una version exacta:

```bash
./git-release.sh v0.2.0 --yes
```

Esto crea y publica el tag Git calculado o indicado. Al llegar ese tag a GitHub, Actions publica automaticamente:

```bash
luis03david/qa_cumplimiento:vX.Y.Z
luis03david/qa_cumplimiento:<commit-sha>
```

Crear tag local sin publicarlo:

```bash
./git-release.sh v0.2.0 --no-push --yes
```

Con `--no-push` no se dispara GitHub Actions y no se publica imagen Docker.

Crear tag anotado:

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
```

Probar publicacion del tag sin publicarlo:

```bash
git push --dry-run origin v0.1.0
```

Publicar tag:

```bash
git push origin v0.1.0
```

Borrar tag local si fue creado por error:

```bash
git tag -d v0.1.0
```

Borrar tag remoto si fue publicado por error:

```bash
git push origin :refs/tags/v0.1.0
```

## Release con GitHub CLI

Verificar autenticacion:

```bash
gh auth status
```

Crear release despues de publicar el tag:

```bash
gh release create v0.1.0 \
  --repo Luis03David/QA_Cumplimiento \
  --title "v0.1.0" \
  --notes "Primera base QA & Cumplimiento: Fase 0, Docker y GitHub Actions."
```

Listar releases:

```bash
gh release list --repo Luis03David/QA_Cumplimiento
```

## GitHub Actions

El workflow automatico se ejecuta en:

- Push a `main`.
- Push de tags `v*`.
- Pull request contra `main`.

Ejecutar manualmente desde GitHub:

1. Abrir el repo en GitHub.
2. Ir a `Actions`.
3. Seleccionar `Docker image`.
4. Usar `Run workflow`.
5. Mantener `push_image=false` si solo se quiere construir y probar.

Publicar a Docker Hub manualmente sin crear release Git:

1. Usar `Run workflow`.
2. Configurar `push_image=true`.
3. Confirmar `image_name`, por defecto `luis03david/qa_cumplimiento`.
4. Definir `image_tag`, por ejemplo `v0.1.0`, `latest` o `qa-base`.

Repository secrets requeridos en GitHub:

- `DOCKERHUB_USERNAME`: usuario de Docker Hub, por ejemplo `luis03david`.
- `DOCKERHUB_TOKEN`: access token de Docker Hub con permiso de lectura/escritura sobre el repo de imagen.

Ruta en GitHub:

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

## Recuperacion Rapida

Si un check falla:

1. Revisar el JSON mas reciente en `resultados/`.
2. Revisar `checks[].message`.
3. Corregir la causa.
4. Ejecutar de nuevo `scripts/run_phase0.sh`.
5. Confirmar `git status --short --branch`.

Si Docker falla:

```bash
docker build --no-cache -t qa-cumplimiento:local .
docker run --rm qa-cumplimiento:local
```

Si el remoto no acepta push:

```bash
git remote -v
git ls-remote --heads origin
gh auth status
```
