#!/usr/bin/env bash
set -Eeuo pipefail

repo="${1:-laurajoyhutchins/factory-floor}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
out_dir="${2:-${repo_root}/.factory-floor/publication-audit/github-complete-${timestamp}}"
mkdir -p "${out_dir}"
chmod 700 "${out_dir}"

status=0

set +e
bash scripts/audit-publication-github.sh \
  "${repo}" \
  "${out_dir}/repository-evidence"
repository_status=$?

bash scripts/audit-publication-workflow-attempts.sh \
  "${repo}" \
  "${out_dir}/workflow-attempts"
attempt_status=$?
set -e

if (( repository_status > status )); then
  status=${repository_status}
fi
if (( attempt_status > status )); then
  status=${attempt_status}
fi

cat >"${out_dir}/status.txt" <<EOF
repository-evidence=${repository_status}
workflow-attempts=${attempt_status}
combined=${status}
EOF

if (( status != 0 )); then
  echo "Complete GitHub publication evidence requires review; combined exit status ${status}." >&2
  exit "${status}"
fi

echo 'Complete GitHub publication evidence was collected. Manual review remains mandatory; publication is not approved.'