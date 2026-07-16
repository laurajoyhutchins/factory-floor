#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

cleanup() {
  pnpm services:down >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if [[ "${FACTORY_FLOOR_VERIFY_CLEAN:-0}" == "1" ]]; then
  pnpm services:clean
fi

pnpm contracts:validate
pnpm contracts:check
pnpm conformance:check
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @factory-floor/console test
pnpm --filter @factory-floor/console build
pnpm test:python
pnpm format:check
docker compose config
pnpm services:up
pnpm services:wait
pnpm db:migrate
pnpm test:integration
pnpm test:conformance
