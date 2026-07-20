#!/usr/bin/env bash
set -euo pipefail

retain_generated_contracts() {
  mkdir -p .factory-floor/ci-metrics
  tar -czf .factory-floor/ci-metrics/generated-contracts.tar.gz \
    packages/contracts-ts/src/generated \
    packages/contracts-ts/src/index.ts \
    packages/contracts-py/factory_floor_contracts
}

pnpm contracts:generate
if ! git diff --exit-code -- contracts/schemas packages/contracts-ts packages/contracts-py; then
  retain_generated_contracts
  echo "Contract generation drift detected. Run pnpm contracts:generate and commit the result." >&2
  exit 1
fi
untracked=$(git ls-files --others --exclude-standard -- contracts/schemas packages/contracts-ts packages/contracts-py)
if [[ -n "${untracked}" ]]; then
  retain_generated_contracts
  echo "Untracked generated contract files detected:" >&2
  echo "${untracked}" >&2
  exit 1
fi
