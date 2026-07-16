#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export FACTORY_FLOOR_ACCEPTANCE_STARTED_AT="${FACTORY_FLOOR_ACCEPTANCE_STARTED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export FACTORY_FLOOR_EVIDENCE_DIR="${FACTORY_FLOOR_EVIDENCE_DIR:-.factory-floor/evidence/m1}"
cleanup(){ pnpm services:clean >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
rm -rf "$FACTORY_FLOOR_EVIDENCE_DIR" .factory-floor/demo-artifacts .factory-floor/acceptance-artifacts
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
pnpm format:check
pnpm test:integration
pnpm acceptance:m1-live-restart
pnpm services:clean
pnpm services:up
pnpm services:wait
pnpm db:migrate
pnpm demo:investigation
node scripts/record-m1-policy-evidence.mjs
pnpm projections:rebuild
pnpm artifacts:reconcile
node scripts/collect-m1-evidence.mjs
pnpm conformance:check
