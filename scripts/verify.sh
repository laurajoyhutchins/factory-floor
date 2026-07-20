#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

verify_static() {
  pnpm contracts:validate
  pnpm contracts:check
  pnpm conformance:check
  pnpm worker-sdk:conformance:check
  pnpm repository:drift:check
  pnpm ci:quality:check
  pnpm audit:publication:syntax
  pnpm lint
  pnpm typecheck

  if [[ "${FACTORY_FLOOR_FORMAT_DIAGNOSTICS:-0}" == "1" ]]; then
    if pnpm format:check 2>&1 | tee format.log; then
      return 0
    fi
    pnpm format
    git diff --name-only --diff-filter=ACMRT > formatted-files.txt
    tar -czf formatted-files.tar.gz -T formatted-files.txt
    return 1
  fi

  pnpm format:check
}

verify_unit() {
  (
    unset DATABASE_URL TEST_DATABASE_URL
    if [[ "${CI:-false}" == "true" ]]; then
      pnpm test:ci
    else
      pnpm test
    fi
  )
  if [[ "${CI:-false}" == "true" ]]; then
    pnpm test:python:ci
  else
    pnpm test:python
  fi
  pnpm --filter @factory-floor/console build
  pnpm --filter @factory-floor/discord-activity build
}

verify_fast() {
  verify_static
  verify_unit
}

verify_services() {
  docker compose config
  pnpm services:up
  pnpm services:wait
  pnpm db:migrate
}

verify_integration() {
  local status=0 cleanup_status=0

  pnpm typecheck || status=$?
  if [[ "$status" -eq 0 ]]; then
    if [[ "${CI:-false}" == "true" ]]; then
      pnpm test:integration:ci || status=$?
    else
      pnpm test:integration || status=$?
    fi
  fi

  pnpm db:reset || cleanup_status=$?
  if [[ "$status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
    status="$cleanup_status"
  fi
  return "$status"
}

verify_acceptance() {
  if [[ "${CI:-false}" == "true" ]]; then
    pnpm test:acceptance:ci
  else
    pnpm test:acceptance
  fi
}

cleanup_services() {
  pnpm services:down >/dev/null 2>&1 || true
}

run_all() {
  trap cleanup_services EXIT INT TERM

  if [[ "${FACTORY_FLOOR_VERIFY_CLEAN:-0}" == "1" ]]; then
    pnpm services:clean
  fi

  verify_fast
  verify_services
  verify_integration
  verify_acceptance
}

stage="${1:-all}"
case "$stage" in
  static)
    verify_static
    ;;
  unit)
    verify_unit
    ;;
  fast)
    verify_fast
    ;;
  services)
    verify_services
    ;;
  integration)
    verify_integration
    ;;
  acceptance)
    verify_acceptance
    ;;
  all)
    run_all
    ;;
  *)
    printf 'Usage: %s {static|unit|fast|services|integration|acceptance|all}\n' "$0" >&2
    exit 2
    ;;
esac
