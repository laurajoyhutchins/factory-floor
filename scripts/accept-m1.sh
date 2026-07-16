#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export FACTORY_FLOOR_ACCEPTANCE_STARTED_AT="${FACTORY_FLOOR_ACCEPTANCE_STARTED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export FACTORY_FLOOR_EVIDENCE_DIR="${FACTORY_FLOOR_EVIDENCE_DIR:-.factory-floor/evidence/m1}"

cleanup() {
  pnpm services:clean >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

rm -rf \
  "$FACTORY_FLOOR_EVIDENCE_DIR" \
  .factory-floor/demo-artifacts \
  .factory-floor/acceptance-artifacts
mkdir -p "$FACTORY_FLOOR_EVIDENCE_DIR"

bash scripts/bootstrap-workspace.sh
pnpm contracts:validate
pnpm contracts:check
pnpm conformance:check

pnpm services:clean
pnpm services:up
pnpm services:wait
pnpm db:migrate
pnpm lint
pnpm typecheck
pnpm test
pnpm test:python

echo "[factory-floor] Repository-wide pnpm format:check is not an M1 gate because main has documented pre-existing Prettier drift across 101 files; Task 12C files are reviewed and formatted independently."

pnpm test:integration

set -o pipefail
pnpm acceptance:m1-live-restart 2>&1 | tee "$FACTORY_FLOOR_EVIDENCE_DIR/restart.log"

pnpm services:clean
pnpm services:up
pnpm services:wait
pnpm db:migrate
pnpm exec tsx scripts/run-m1-cancellation-evidence.ts 2>&1 | tee "$FACTORY_FLOOR_EVIDENCE_DIR/cancellation.log"

pnpm services:clean
pnpm services:up
pnpm services:wait
pnpm db:migrate
pnpm demo:investigation 2>&1 | tee "$FACTORY_FLOOR_EVIDENCE_DIR/investigation.log"
pnpm exec tsx scripts/record-m1-policy-evidence.ts 2>&1 | tee "$FACTORY_FLOOR_EVIDENCE_DIR/policy.log"
node scripts/collect-m1-evidence.mjs
pnpm conformance:check
