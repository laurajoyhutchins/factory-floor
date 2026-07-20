#!/usr/bin/env bash
set -euo pipefail

: "${HEAD_REF:?HEAD_REF is required}"

bash scripts/bootstrap-workspace.sh
git fetch origin main
git checkout origin/main -- \
  .github/workflows/repository-verification.yml \
  scripts/bootstrap-workspace.sh
rm -f \
  .github/workflows/patch-durable-result-handoff.yml \
  .github/.durable-result-handoff-trigger \
  scripts/patch-durable-result-handoff.py \
  scripts/patch-result-handoff-database.py \
  scripts/patch-result-handoff-worker.py \
  scripts/patch-result-handoff-commit.py \
  scripts/patch-result-handoff-recovery.py \
  scripts/promote-durable-result-handoff.sh

git add -A
git diff --cached --name-only | sort > /tmp/actual-paths
cat > /tmp/allowed-paths <<'PATHS'
.github/.durable-result-handoff-trigger
.github/workflows/patch-durable-result-handoff.yml
.github/workflows/repository-verification.yml
packages/db/src/database.ts
packages/db/src/migrations/zzzzzzzz_20260720_worker_result_submission_commit.ts
packages/runtime-core/src/commit/execution-commit-service.ts
packages/runtime-core/src/observability/recovery-service.ts
packages/runtime-core/src/worker/worker-protocol-service.ts
scripts/bootstrap-workspace.sh
scripts/patch-durable-result-handoff.py
scripts/patch-result-handoff-commit.py
scripts/patch-result-handoff-database.py
scripts/patch-result-handoff-recovery.py
scripts/patch-result-handoff-worker.py
scripts/promote-durable-result-handoff.sh
tests/integration/runtime-core/durable-result-handoff-recovery.test.ts
PATHS
sort -o /tmp/allowed-paths /tmp/allowed-paths
unexpected="$(comm -23 /tmp/actual-paths /tmp/allowed-paths)"
if [[ -n "$unexpected" ]]; then
  printf 'Unexpected promotion paths:\n%s\n' "$unexpected" >&2
  exit 1
fi
for required in \
  packages/db/src/database.ts \
  packages/runtime-core/src/commit/execution-commit-service.ts \
  packages/runtime-core/src/observability/recovery-service.ts \
  packages/runtime-core/src/worker/worker-protocol-service.ts; do
  grep -Fqx "$required" /tmp/actual-paths || {
    printf 'Required promoted path was not staged: %s\n' "$required" >&2
    exit 1
  }
done

git config user.name github-actions[bot]
git config user.email 41898282+github-actions[bot]@users.noreply.github.com
git commit -m 'feat: recover durable worker result handoffs'
git push origin "HEAD:${HEAD_REF}"
