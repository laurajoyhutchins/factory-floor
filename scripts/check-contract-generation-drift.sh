#!/usr/bin/env bash
set -euo pipefail
pnpm contracts:generate
if ! git diff --exit-code -- contracts/schemas packages/contracts-ts packages/contracts-py; then
  echo "Contract generation drift detected. Run pnpm contracts:generate and commit the result." >&2
  exit 1
fi
