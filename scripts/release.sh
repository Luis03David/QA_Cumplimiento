#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

REMOTE="origin"
BRANCH="main"
VERSION=""
BUMP="auto"
DRY_RUN=false
PUSH=true
CREATE_GITHUB_RELEASE=false
YES=false

usage() {
  cat <<'EOF'
Uso:
  ./git-release.sh [version] [opciones]

Ejemplos:
  ./git-release.sh --dry-run
  ./git-release.sh --yes
  ./git-release.sh --minor --yes
  ./git-release.sh v0.2.0 --dry-run
  ./git-release.sh v0.2.0 --yes

Opciones:
  --dry-run             Muestra lo que haria sin crear tag ni publicar.
  --no-push             Crea el tag local, pero no lo publica al remoto.
  --patch               Incrementa patch: v0.1.0 -> v0.1.1.
  --minor               Incrementa minor: v0.1.0 -> v0.2.0.
  --major               Incrementa major: v0.1.0 -> v1.0.0.
  --github-release      Crea release en GitHub con gh despues de publicar el tag.
  --remote NAME         Remoto Git. Default: origin.
  --branch NAME         Branch esperado. Default: main.
  --yes                 No pedir confirmacion interactiva.
  -h, --help            Muestra esta ayuda.

Si no se indica version, calcula el siguiente semver desde el ultimo tag vX.Y.Z.
Por defecto usa --auto:
  - major si hay commits con BREAKING CHANGE o tipo con !, por ejemplo feat!: ...
  - minor si hay commits feat...
  - patch para fix, docs, chore, ci, test, refactor u otros cambios.
Si no existe ningun tag semver, usa v0.1.0.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --no-push)
      PUSH=false
      shift
      ;;
    --patch)
      BUMP="patch"
      shift
      ;;
    --minor)
      BUMP="minor"
      shift
      ;;
    --major)
      BUMP="major"
      shift
      ;;
    --github-release)
      CREATE_GITHUB_RELEASE=true
      shift
      ;;
    --remote)
      [[ $# -ge 2 ]] || die "--remote requiere valor"
      REMOTE="$2"
      shift 2
      ;;
    --branch)
      [[ $# -ge 2 ]] || die "--branch requiere valor"
      BRANCH="$2"
      shift 2
      ;;
    --yes)
      YES=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      die "opcion desconocida: $1"
      ;;
    *)
      [[ -z "$VERSION" ]] || die "solo se permite una version"
      VERSION="$1"
      shift
      ;;
  esac
done

command -v git >/dev/null 2>&1 || die "git no esta instalado"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  die "este comando debe ejecutarse dentro de un repo Git"
fi

if git remote get-url "$REMOTE" >/dev/null 2>&1; then
  git fetch "$REMOTE" --tags --quiet || die "no se pudieron traer tags desde $REMOTE"
else
  die "no existe el remoto $REMOTE"
fi

latest_semver_tag() {
  git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n 1
}

next_version() {
  local latest="$1"
  local bump="$2"
  if [[ -z "$latest" ]]; then
    echo "v0.1.0"
    return
  fi

  local raw="${latest#v}"
  local major minor patch
  IFS='.' read -r major minor patch <<<"$raw"

  case "$bump" in
    major)
      echo "v$((major + 1)).0.0"
      ;;
    minor)
      echo "v${major}.$((minor + 1)).0"
      ;;
    patch)
      echo "v${major}.${minor}.$((patch + 1))"
      ;;
    *)
      die "tipo de version invalido: $bump"
      ;;
  esac
}

commit_range_for_bump() {
  local latest="$1"
  if [[ -n "$latest" ]]; then
    echo "${latest}..HEAD"
  else
    echo "HEAD"
  fi
}

detect_bump() {
  local latest="$1"
  local range
  range=$(commit_range_for_bump "$latest")

  local subjects bodies
  subjects=$(git log --format=%s "$range")
  bodies=$(git log --format=%b "$range")

  if grep -Eq '(^|!:)BREAKING CHANGE|^[a-zA-Z]+(\([^)]+\))?!:' <<<"$subjects"$'\n'"$bodies"; then
    echo "major"
    return
  fi

  if grep -Eq '^feat(\([^)]+\))?:' <<<"$subjects"; then
    echo "minor"
    return
  fi

  echo "patch"
}

LATEST_TAG=$(latest_semver_tag)
if [[ -z "$VERSION" ]]; then
  if [[ "$BUMP" == "auto" ]]; then
    BUMP=$(detect_bump "$LATEST_TAG")
  fi
  VERSION=$(next_version "$LATEST_TAG" "$BUMP")
fi

[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version invalida: $VERSION. Usa formato vX.Y.Z"

if git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null; then
  die "el tag $VERSION ya existe"
fi

current_branch=$(git branch --show-current)
[[ "$current_branch" == "$BRANCH" ]] || die "branch actual '$current_branch'; se esperaba '$BRANCH'"

if [[ -n "$(git status --porcelain)" ]]; then
  if [[ "$DRY_RUN" == true ]]; then
    info "working tree con cambios; dry-run continua sin crear nada"
  else
    die "working tree sucio. Haz commit o stash antes de release"
  fi
fi

if git rev-parse --verify "$REMOTE/$BRANCH" >/dev/null 2>&1; then
  local_head=$(git rev-parse "$BRANCH")
  remote_head=$(git rev-parse "$REMOTE/$BRANCH")
  if [[ "$local_head" != "$remote_head" ]]; then
    if [[ "$DRY_RUN" == true ]]; then
      info "$BRANCH no coincide con $REMOTE/$BRANCH; dry-run continua"
    else
      die "$BRANCH no esta sincronizado con $REMOTE/$BRANCH"
    fi
  fi
fi

info "ultimo tag semver: ${LATEST_TAG:-ninguno}"
info "tipo de incremento: $BUMP"
info "version a crear: $VERSION"
info "commit objetivo: $(git rev-parse --short HEAD)"
info "remoto: $REMOTE"
info "branch: $BRANCH"

if [[ "$DRY_RUN" == true ]]; then
  info "dry-run: no se creara tag ni release"
  info "comandos que se ejecutarian:"
  echo "git tag -a $VERSION -m \"Release $VERSION\""
  if [[ "$PUSH" == true ]]; then
    echo "git push $REMOTE $BRANCH"
    echo "git push $REMOTE $VERSION"
    echo "# GitHub Actions publicara luis03david/qa_cumplimiento:$VERSION al recibir el tag"
  fi
  if [[ "$CREATE_GITHUB_RELEASE" == true ]]; then
    echo "gh release create $VERSION --title \"$VERSION\" --notes \"Release $VERSION\""
  fi
  exit 0
fi

if [[ "$YES" != true ]]; then
  read -r -p "Crear release $VERSION desde $(git rev-parse --short HEAD)? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || die "release cancelado"
fi

git tag -a "$VERSION" -m "Release $VERSION"

if [[ "$PUSH" == true ]]; then
  git push "$REMOTE" "$BRANCH"
  git push "$REMOTE" "$VERSION"
  info "GitHub Actions publicara Docker image: luis03david/qa_cumplimiento:$VERSION"
fi

if [[ "$CREATE_GITHUB_RELEASE" == true ]]; then
  command -v gh >/dev/null 2>&1 || die "gh no esta instalado"
  gh release create "$VERSION" \
    --title "$VERSION" \
    --notes "Release $VERSION"
fi

info "release listo: $VERSION"
