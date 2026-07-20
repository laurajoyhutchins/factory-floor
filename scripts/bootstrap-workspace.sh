#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PNPM_VERSION="${FACTORY_FLOOR_PNPM_VERSION:-10.12.1}"
EXPECTED_NODE_MAJOR="${FACTORY_FLOOR_NODE_MAJOR:-22}"
EXPECTED_PYTHON_VERSION="${FACTORY_FLOOR_PYTHON_VERSION:-3.12}"
LOCAL_BIN="$HOME/.local/bin"
PATH_EXPORT='export PATH="$HOME/.local/bin:$PATH"'

log() {
  printf '[factory-floor] %s\n' "$*"
}

fail() {
  printf '[factory-floor] error: %s\n' "$*" >&2
  exit 1
}

ensure_profile_path() {
  mkdir -p "$LOCAL_BIN"
  export PATH="$LOCAL_BIN:$PATH"

  local profile
  for profile in "$HOME/.bashrc" "$HOME/.profile"; do
    touch "$profile"
    if ! grep -Fqx "$PATH_EXPORT" "$profile"; then
      printf '\n%s\n' "$PATH_EXPORT" >> "$profile"
    fi
  done
}

select_python() {
  local candidate
  for candidate in "python${EXPECTED_PYTHON_VERSION}" python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

verify_runtimes() {
  command -v node >/dev/null 2>&1 || fail "Node.js is required; configure this environment with Node ${EXPECTED_NODE_MAJOR}."
  command -v corepack >/dev/null 2>&1 || fail "Corepack is required and normally ships with Node ${EXPECTED_NODE_MAJOR}."

  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$node_major" == "$EXPECTED_NODE_MAJOR" ]] || fail "Expected Node ${EXPECTED_NODE_MAJOR}.x, found $(node --version)."

  PYTHON_BIN="$(select_python)" || fail "Python ${EXPECTED_PYTHON_VERSION} is required."
  local python_version
  python_version="$($PYTHON_BIN -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  [[ "$python_version" == "$EXPECTED_PYTHON_VERSION" ]] || fail "Expected Python ${EXPECTED_PYTHON_VERSION}, found $($PYTHON_BIN --version 2>&1)."
}

install_package_managers() {
  if ! command -v uv >/dev/null 2>&1; then
    command -v curl >/dev/null 2>&1 || fail "curl is required to install uv."
    log "Installing uv into $LOCAL_BIN"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$LOCAL_BIN:$PATH"
  fi

  log "Activating pnpm ${PNPM_VERSION} through Corepack"
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
  corepack enable --install-directory "$LOCAL_BIN" pnpm
}

discover_python_projects() {
  find "$ROOT_DIR" \
    -type d \( \
      -name .git -o \
      -name .venv -o \
      -name node_modules -o \
      -name dist -o \
      -name build -o \
      -name coverage -o \
      -name generated \
    \) -prune -o \
    -type f -name pyproject.toml -print0
}

install_dependencies() {
  cd "$ROOT_DIR"

  if [[ -f package.json ]]; then
    [[ -f pnpm-lock.yaml ]] || fail "pnpm-lock.yaml is required for the JavaScript workspace."
    log "Installing JavaScript dependencies from pnpm-lock.yaml"
    pnpm install --frozen-lockfile
  fi

  local manifest project relative_project project_count=0
  while IFS= read -r -d '' manifest; do
    project="${manifest%/pyproject.toml}"
    [[ -f "$project/uv.lock" ]] || fail "Python project ${project#$ROOT_DIR/} is missing uv.lock."
    relative_project="${project#$ROOT_DIR/}"
    [[ "$project" == "$ROOT_DIR" ]] && relative_project="."
    log "Synchronizing locked Python project ${relative_project}"
    uv sync --project "$project" --locked
    project_count=$((project_count + 1))
  done < <(discover_python_projects | sort -z)

  ((project_count > 0)) || fail "No Python projects were discovered."
  log "Synchronized ${project_count} locked Python projects"
}

print_summary() {
  log "Environment ready"
  printf '  repository: %s\n' "$ROOT_DIR"
  printf '  node:       %s\n' "$(node --version)"
  printf '  pnpm:       %s\n' "$(pnpm --version)"
  printf '  python:     %s\n' "$($PYTHON_BIN --version 2>&1)"
  printf '  uv:         %s\n' "$(uv --version)"
  if command -v docker >/dev/null 2>&1; then
    printf '  docker:     %s\n' "$(docker --version)"
  fi
  if command -v gh >/dev/null 2>&1; then
    printf '  github:     %s\n' "$(gh --version | head -n 1)"
  fi
}

ensure_profile_path
verify_runtimes
install_package_managers
if ! git config --global --get-all safe.directory 2>/dev/null | grep -Fqx "$ROOT_DIR"; then
  git config --global --add safe.directory "$ROOT_DIR" 2>/dev/null || true
fi
install_dependencies
print_summary
