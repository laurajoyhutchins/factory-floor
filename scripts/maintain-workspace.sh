#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_NODE_MAJOR="${FACTORY_FLOOR_NODE_MAJOR:-22}"
EXPECTED_PYTHON_VERSION="${FACTORY_FLOOR_PYTHON_VERSION:-3.12}"
EXPECTED_PNPM_VERSION="${FACTORY_FLOOR_PNPM_VERSION:-10.12.1}"

log() {
  printf '[factory-floor maintenance] %s\n' "$*"
}

warn() {
  printf '[factory-floor maintenance] warning: %s\n' "$*" >&2
}

fail() {
  printf '[factory-floor maintenance] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: bash scripts/maintain-workspace.sh [command ...]

Commands may be combined and run from left to right:
  doctor          Check toolchain, lockfiles, Git state, disk, and Docker.
  sync            Re-run the shared reproducible bootstrap.
  verify          Run available lint, typecheck, unit, Python, and Compose checks.
  integration     Run the root test:integration script when it exists.
  clean           Remove transient build, test, and language caches.
  reset           Remove local dependency environments, then bootstrap again.
  pull-services   Pull Docker Compose service images when Compose is available.
  all             Run sync followed by verify.
  help            Show this help.

With no command, the script runs doctor only. Destructive cleanup is never implicit.
USAGE
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

require_expected_toolchain() {
  command -v node >/dev/null 2>&1 || fail "Node.js ${EXPECTED_NODE_MAJOR}.x is required."
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$node_major" == "$EXPECTED_NODE_MAJOR" ]] || fail "Expected Node ${EXPECTED_NODE_MAJOR}.x, found $(node --version)."

  PYTHON_BIN="$(select_python)" || fail "Python ${EXPECTED_PYTHON_VERSION} is required."
  local python_version
  python_version="$($PYTHON_BIN -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  [[ "$python_version" == "$EXPECTED_PYTHON_VERSION" ]] || fail "Expected Python ${EXPECTED_PYTHON_VERSION}, found $($PYTHON_BIN --version 2>&1)."

  command -v pnpm >/dev/null 2>&1 || fail "pnpm ${EXPECTED_PNPM_VERSION} is required; run the sync command first."
  [[ "$(pnpm --version)" == "$EXPECTED_PNPM_VERSION" ]] || fail "Expected pnpm ${EXPECTED_PNPM_VERSION}, found $(pnpm --version)."
  command -v uv >/dev/null 2>&1 || fail "uv is required; run the sync command first."
}

run_root_script_if_present() {
  local script_name="$1"
  if [[ ! -f "$ROOT_DIR/package.json" ]]; then
    log "Skipping pnpm ${script_name}: package.json does not exist yet"
    return 0
  fi

  if node -e "const p=require('./package.json'); process.exit(p.scripts?.['${script_name}'] ? 0 : 1)"; then
    log "Running pnpm ${script_name}"
    pnpm "$script_name"
  else
    log "Skipping pnpm ${script_name}: script is not defined"
  fi
}

doctor() {
  cd "$ROOT_DIR"
  require_expected_toolchain

  log "Toolchain"
  printf '  node:   %s\n' "$(node --version)"
  printf '  pnpm:   %s\n' "$(pnpm --version)"
  printf '  python: %s\n' "$($PYTHON_BIN --version 2>&1)"
  printf '  uv:     %s\n' "$(uv --version)"

  log "Repository"
  printf '  root:   %s\n' "$ROOT_DIR"
  printf '  branch: %s\n' "$(git branch --show-current 2>/dev/null || printf 'detached or unavailable')"
  if [[ -n "$(git status --short 2>/dev/null || true)" ]]; then
    warn "The working tree has uncommitted changes."
    git status --short
  else
    printf '  status: clean\n'
  fi
  git diff --check

  if [[ -f package.json && ! -f pnpm-lock.yaml ]]; then
    warn "package.json exists without pnpm-lock.yaml; commit the lockfile after initial resolution."
  fi
  if find "$ROOT_DIR" -name pyproject.toml -not -path '*/.venv/*' -print -quit | grep -q . && [[ ! -f "$ROOT_DIR/uv.lock" && ! -f "$ROOT_DIR/packages/worker-sdk-py/uv.lock" ]]; then
    warn "A Python project exists without a visible uv.lock."
  fi

  log "Storage"
  df -h "$ROOT_DIR" | tail -n 1

  if command -v docker >/dev/null 2>&1; then
    printf '  docker: %s\n' "$(docker --version)"
    if docker info >/dev/null 2>&1; then
      printf '  daemon: reachable\n'
    else
      warn "Docker is installed but the daemon is not reachable."
    fi
  else
    warn "Docker is not installed; integration services will be unavailable."
  fi
}

sync_workspace() {
  log "Synchronizing the workspace through the shared bootstrap"
  bash "$ROOT_DIR/scripts/bootstrap-workspace.sh"
}

verify_workspace() {
  cd "$ROOT_DIR"
  require_expected_toolchain
  git diff --check

  run_root_script_if_present lint
  run_root_script_if_present typecheck
  run_root_script_if_present test

  if [[ -f "$ROOT_DIR/packages/worker-sdk-py/pyproject.toml" ]]; then
    log "Running Python worker SDK tests"
    uv run --project "$ROOT_DIR/packages/worker-sdk-py" pytest
  else
    log "Skipping Python worker SDK tests: project is not initialized yet"
  fi

  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    if [[ -f "$ROOT_DIR/docker-compose.yml" || -f "$ROOT_DIR/compose.yml" || -f "$ROOT_DIR/compose.yaml" ]]; then
      log "Validating Docker Compose configuration"
      docker compose config >/dev/null
    else
      log "Skipping Docker Compose validation: no Compose file exists yet"
    fi
  else
    log "Skipping Docker Compose validation: Docker Compose is unavailable"
  fi
}

verify_integration() {
  cd "$ROOT_DIR"
  require_expected_toolchain
  run_root_script_if_present test:integration
}

clean_workspace() {
  log "Removing transient build and test caches"
  find "$ROOT_DIR" \
    -type d \( -name .git -o -name node_modules -o -name .venv \) -prune -o \
    -type d \( -name dist -o -name build -o -name coverage -o -name .pytest_cache -o -name .mypy_cache -o -name .ruff_cache -o -name __pycache__ \) \
    -prune -exec rm -rf {} +
  find "$ROOT_DIR" \
    -type d \( -name .git -o -name node_modules -o -name .venv \) -prune -o \
    -type f \( -name '*.tsbuildinfo' -o -name '*.pyc' -o -name '*.pyo' \) -exec rm -f {} +
}

reset_workspace() {
  clean_workspace
  log "Removing local dependency installations"
  find "$ROOT_DIR" \
    -type d \( -name .git \) -prune -o \
    -type d \( -name node_modules -o -name .venv \) -prune -exec rm -rf {} +
  rm -rf "$ROOT_DIR/.pnpm-store"
  sync_workspace
}

pull_services() {
  cd "$ROOT_DIR"
  command -v docker >/dev/null 2>&1 || fail "Docker is required to pull service images."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose is required to pull service images."
  [[ -f docker-compose.yml || -f compose.yml || -f compose.yaml ]] || fail "No Docker Compose file exists yet."
  log "Pulling Docker Compose service images"
  docker compose pull
}

run_command() {
  case "$1" in
    doctor) doctor ;;
    sync) sync_workspace ;;
    verify) verify_workspace ;;
    integration) verify_integration ;;
    clean) clean_workspace ;;
    reset) reset_workspace ;;
    pull-services) pull_services ;;
    all)
      sync_workspace
      verify_workspace
      ;;
    help|-h|--help) usage ;;
    *)
      usage >&2
      fail "Unknown maintenance command: $1"
      ;;
  esac
}

if [[ "$#" -eq 0 ]]; then
  set -- doctor
fi

for command_name in "$@"; do
  run_command "$command_name"
done
