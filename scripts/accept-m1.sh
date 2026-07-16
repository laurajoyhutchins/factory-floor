#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export FACTORY_FLOOR_ACCEPTANCE_STARTED_AT="${FACTORY_FLOOR_ACCEPTANCE_STARTED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export FACTORY_FLOOR_EVIDENCE_DIR="${FACTORY_FLOOR_EVIDENCE_DIR:-.factory-floor/evidence/m1}"
export ARTIFACT_STORE_ROOT="${ARTIFACT_STORE_ROOT:-.factory-floor/demo-artifacts}"
if [[ "$ARTIFACT_STORE_ROOT" != /* ]]; then
  export ARTIFACT_STORE_ROOT="$ROOT/$ARTIFACT_STORE_ROOT"
fi

EVIDENCE_CONTROL_PLANE_PID=""

stop_evidence_control_plane() {
  if [[ -z "$EVIDENCE_CONTROL_PLANE_PID" ]]; then
    return
  fi
  kill -TERM "$EVIDENCE_CONTROL_PLANE_PID" >/dev/null 2>&1 || true
  wait "$EVIDENCE_CONTROL_PLANE_PID" >/dev/null 2>&1 || true
  EVIDENCE_CONTROL_PLANE_PID=""
}

cleanup() {
  stop_evidence_control_plane
  node scripts/sanitize-m1-evidence.mjs \
    "$FACTORY_FLOOR_EVIDENCE_DIR" \
    m1-acceptance.log \
    >/dev/null 2>&1 || true
  pnpm services:clean >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

rm -rf \
  "$FACTORY_FLOOR_EVIDENCE_DIR" \
  "$ARTIFACT_STORE_ROOT" \
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

pnpm exec prettier --check \
  .github/workflows/task1-verification.yml \
  apps/cli/src/index.ts \
  apps/control-plane/src/routes/inspection.ts \
  apps/control-plane/test/inspection-routes.test.ts \
  docs/conformance/durable-reactive-graph-ledger.yaml \
  docs/evidence/m1-durable-reactive-graph.md \
  eslint.config.js \
  package.json \
  packages/runtime-core/src/index.ts \
  packages/runtime-core/src/observability/observability-service.ts \
  packages/runtime-core/src/policies/policy-decision-service.ts \
  scripts/collect-m1-evidence.mjs \
  scripts/record-m1-policy-evidence.ts \
  scripts/run-m1-cancellation-evidence.ts \
  scripts/sanitize-m1-evidence.mjs \
  tests/integration/runtime-core/policy-decision.test.ts \
  tests/integration/runtime-core/registration-and-system.test.ts

echo "[factory-floor] Repository-wide pnpm format:check is not an M1 gate because main has documented pre-existing Prettier drift across 101 files; Task 12C Prettier-supported files passed the scoped check above."

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

export FACTORY_FLOOR_CONTROL_PLANE_URL="http://127.0.0.1:3000"
DATABASE_URL="$DATABASE_URL" \
PORT=3000 \
HOST=127.0.0.1 \
ARTIFACT_STORE_ROOT="$ARTIFACT_STORE_ROOT" \
WORKER_API_BEARER_TOKEN=m1-evidence-worker-token \
  node --import tsx apps/control-plane/src/server.ts \
  >"$FACTORY_FLOOR_EVIDENCE_DIR/evidence-control-plane.log" 2>&1 &
EVIDENCE_CONTROL_PLANE_PID="$!"

for _ in $(seq 1 300); do
  if curl --fail --silent "$FACTORY_FLOOR_CONTROL_PLANE_URL/health" >/dev/null; then
    break
  fi
  if ! kill -0 "$EVIDENCE_CONTROL_PLANE_PID" >/dev/null 2>&1; then
    cat "$FACTORY_FLOOR_EVIDENCE_DIR/evidence-control-plane.log"
    exit 1
  fi
  sleep 0.1
done
curl --fail --silent "$FACTORY_FLOOR_CONTROL_PLANE_URL/health" >/dev/null

node scripts/collect-m1-evidence.mjs
stop_evidence_control_plane
pnpm conformance:check
