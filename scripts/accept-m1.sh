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

run_phase() {
  local phase="$1"
  shift
  local output=".factory-floor/ci-metrics/${phase}.json"
  node scripts/run-ci-stage.mjs --stage "$phase" --output "$output" -- "$@"
}

write_pull_request_deferral() {
  local commit_sha completed_at
  commit_sha="$(git rev-parse HEAD)"
  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$FACTORY_FLOOR_EVIDENCE_DIR"
  cat >"$FACTORY_FLOOR_EVIDENCE_DIR/acceptance-evidence.json" <<JSON
{
  "schemaVersion": 2,
  "status": "deferred_to_trusted_cadence",
  "commitSha": "$commit_sha",
  "startedAt": "$FACTORY_FLOOR_ACCEPTANCE_STARTED_AT",
  "completedAt": "$completed_at",
  "reason": "Pull requests already run canonical static, unit, service, integration, and live-restart verification. Full clean acceptance runs on main and direct invocation.",
  "baseline": "docs/reference/m1-acceptance-baseline.json"
}
JSON
  cat >"$FACTORY_FLOOR_EVIDENCE_DIR/SUMMARY.md" <<MARKDOWN
# Milestone 1 acceptance cadence

- Status: deferred_to_trusted_cadence
- Commit: $commit_sha
- Reason: Pull requests already run canonical static, unit, service, integration, and live-restart verification.
- Full clean acceptance runs on main and direct invocation.
- Baseline: \`docs/reference/m1-acceptance-baseline.json\`
MARKDOWN
  printf '[factory-floor] Full clean acceptance deferred for pull-request cadence; canonical verification remains authoritative.\n'
}

rm -rf \
  "$FACTORY_FLOOR_EVIDENCE_DIR" \
  "$ARTIFACT_STORE_ROOT" \
  .factory-floor/acceptance-artifacts
mkdir -p "$FACTORY_FLOOR_EVIDENCE_DIR" .factory-floor/ci-metrics

if [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" && "${FACTORY_FLOOR_FORCE_CLEAN_ACCEPTANCE:-0}" != "1" ]]; then
  write_pull_request_deferral
  exit 0
fi

cleanup() {
  node scripts/sanitize-m1-evidence.mjs \
    "$FACTORY_FLOOR_EVIDENCE_DIR" \
    m1-acceptance.log \
    >/dev/null 2>&1 || true
  pnpm services:clean >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

run_phase m1-bootstrap bash scripts/bootstrap-workspace.sh
pnpm services:clean
run_phase m1-static pnpm verify:static
run_phase m1-unit pnpm verify:unit
run_phase m1-services pnpm verify:services
run_phase m1-integration pnpm verify:integration

run_phase m1-live-restart bash -c '
  set -Eeuo pipefail
  set -o pipefail
  acceptance_port="${FACTORY_FLOOR_ACCEPTANCE_PORT:-3112}"
  acceptance_url="http://127.0.0.1:${acceptance_port}"
  FACTORY_FLOOR_CONTROL_PLANE_URL="$acceptance_url" \
  CONTROL_PLANE_PUBLIC_URL="$acceptance_url" \
    pnpm acceptance:m1-live-restart 2>&1 | tee "$FACTORY_FLOOR_EVIDENCE_DIR/restart.log"
'

run_phase m1-cancellation bash -c '
  set -Eeuo pipefail
  set -o pipefail
  pnpm services:clean
  pnpm services:up
  pnpm services:wait
  pnpm db:migrate
  pnpm exec tsx scripts/run-m1-cancellation-evidence.ts 2>&1 | tee "$FACTORY_FLOOR_EVIDENCE_DIR/cancellation.log"
'

run_phase m1-investigation-evidence bash -c '
  set -Eeuo pipefail
  set -o pipefail
  pnpm services:clean
  pnpm services:up
  pnpm services:wait
  pnpm db:migrate
  pnpm demo:investigation 2>&1 | tee "$FACTORY_FLOOR_EVIDENCE_DIR/investigation.log"
  pnpm exec tsx scripts/record-m1-policy-evidence.ts 2>&1 | tee "$FACTORY_FLOOR_EVIDENCE_DIR/policy.log"
'

run_phase m1-collect-evidence bash -c '
  set -Eeuo pipefail
  export FACTORY_FLOOR_CONTROL_PLANE_URL="http://127.0.0.1:3000"
  DATABASE_URL="$DATABASE_URL" \
  PORT=3000 \
  HOST=127.0.0.1 \
  ARTIFACT_STORE_ROOT="$ARTIFACT_STORE_ROOT" \
  WORKER_API_BEARER_TOKEN=m1-evidence-worker-token \
    node --import tsx apps/control-plane/src/server.ts \
    >"$FACTORY_FLOOR_EVIDENCE_DIR/evidence-control-plane.log" 2>&1 &
  evidence_pid="$!"
  stop_evidence_control_plane() {
    kill -TERM "$evidence_pid" >/dev/null 2>&1 || true
    wait "$evidence_pid" >/dev/null 2>&1 || true
  }
  trap stop_evidence_control_plane EXIT INT TERM

  for _ in $(seq 1 300); do
    if curl --fail --silent "$FACTORY_FLOOR_CONTROL_PLANE_URL/health" >/dev/null; then
      break
    fi
    if ! kill -0 "$evidence_pid" >/dev/null 2>&1; then
      cat "$FACTORY_FLOOR_EVIDENCE_DIR/evidence-control-plane.log"
      exit 1
    fi
    sleep 0.1
  done
  curl --fail --silent "$FACTORY_FLOOR_CONTROL_PLANE_URL/health" >/dev/null
  node scripts/collect-m1-evidence.mjs
'

run_phase m1-conformance-summary pnpm conformance:check
