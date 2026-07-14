#!/usr/bin/env bash
set -euo pipefail
pnpm contracts:generate
if ! git diff --exit-code -- contracts/schemas packages/contracts-ts packages/contracts-py; then
  echo "Contract generation drift detected. Run pnpm contracts:generate and commit the result." >&2
  exit 1
fi
untracked=$(git ls-files --others --exclude-standard -- contracts/schemas packages/contracts-ts packages/contracts-py)
if [[ -n "${untracked}" ]]; then
  echo "Untracked generated contract files detected:" >&2
  echo "${untracked}" >&2
  exit 1
fi
