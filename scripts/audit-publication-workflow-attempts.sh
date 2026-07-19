#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

required=(gh jq python3 gitleaks rg)
missing=()
for command_name in "${required[@]}"; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    missing+=("${command_name}")
  fi
done
if (( ${#missing[@]} > 0 )); then
  printf 'Missing required audit tools: %s\n' "${missing[*]}" >&2
  exit 2
fi

gh auth status >/dev/null 2>&1
repo="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
out_dir="${2:-${repo_root}/.factory-floor/publication-audit/workflow-attempts-${timestamp}}"
raw_dir="${out_dir}/sensitive-raw"
safe_dir="${out_dir}/sanitized"
logs_dir="${raw_dir}/workflow-attempt-logs"
mkdir -p "${logs_dir}" "${safe_dir}"
chmod 700 "${out_dir}" "${raw_dir}" "${safe_dir}" "${logs_dir}"

{
  gh --version | head -n 1
  jq --version
  python3 --version
  gitleaks version
  rg --version | head -n 1
} >"${safe_dir}/tool-versions.txt" 2>&1

safe_extract_zip() {
  local archive="$1"
  local destination="$2"
  python3 - "${archive}" "${destination}" <<'PY'
import pathlib
import stat
import sys
import zipfile

archive_path = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2]).resolve()
maximum_entries = 100_000
maximum_uncompressed_bytes = 5 * 1024 * 1024 * 1024

with zipfile.ZipFile(archive_path) as bundle:
    entries = bundle.infolist()
    if len(entries) > maximum_entries:
        raise SystemExit(f"archive contains too many entries: {len(entries)}")

    total_size = sum(entry.file_size for entry in entries)
    if total_size > maximum_uncompressed_bytes:
        raise SystemExit(f"archive expands beyond limit: {total_size} bytes")

    for entry in entries:
        name = entry.filename.replace("\\", "/")
        target = (destination / name).resolve()
        if target != destination and destination not in target.parents:
            raise SystemExit(f"archive path escapes destination: {entry.filename}")

        file_type = (entry.external_attr >> 16) & 0o170000
        if file_type == stat.S_IFLNK:
            raise SystemExit(f"archive contains a symbolic link: {entry.filename}")

    destination.mkdir(parents=True, exist_ok=True)
    bundle.extractall(destination)
PY
}

gh api --paginate --slurp "repos/${repo}/actions/runs?per_page=100" \
  >"${raw_dir}/workflow-run-pages.json"
jq '[.[]?.workflow_runs[]?]' "${raw_dir}/workflow-run-pages.json" \
  >"${raw_dir}/workflow-runs.json"

: >"${raw_dir}/attempt-inventory.tsv"
while IFS=$'\t' read -r run_id run_attempt; do
  [[ -n "${run_id}" ]] || continue
  if [[ -z "${run_attempt}" || "${run_attempt}" == "null" ]]; then
    run_attempt=1
  fi
  for ((attempt = 1; attempt <= run_attempt; attempt += 1)); do
    printf '%s\t%s\n' "${run_id}" "${attempt}" \
      >>"${raw_dir}/attempt-inventory.tsv"
  done
done < <(jq -r '.[] | [.id, (.run_attempt // 1)] | @tsv' "${raw_dir}/workflow-runs.json")

: >"${raw_dir}/archive-validation-errors.txt"
: >"${raw_dir}/unavailable-attempt-logs.txt"
: >"${raw_dir}/downloaded-attempt-logs.txt"
while IFS=$'\t' read -r run_id attempt; do
  [[ -n "${run_id}" && -n "${attempt}" ]] || continue
  run_dir="${logs_dir}/${run_id}"
  zip_path="${run_dir}/attempt-${attempt}.zip"
  extract_path="${run_dir}/attempt-${attempt}"
  mkdir -p "${run_dir}"

  if gh api "repos/${repo}/actions/runs/${run_id}/attempts/${attempt}/logs" \
    >"${zip_path}" 2>/dev/null; then
    if safe_extract_zip "${zip_path}" "${extract_path}" \
      2>>"${raw_dir}/archive-validation-errors.txt"; then
      printf '%s\t%s\n' "${run_id}" "${attempt}" \
        >>"${raw_dir}/downloaded-attempt-logs.txt"
    else
      printf '%s\t%s\tunsafe-or-invalid-archive\n' "${run_id}" "${attempt}" \
        >>"${raw_dir}/unavailable-attempt-logs.txt"
    fi
  else
    rm -f "${zip_path}"
    printf '%s\t%s\tunavailable-or-expired\n' "${run_id}" "${attempt}" \
      >>"${raw_dir}/unavailable-attempt-logs.txt"
  fi
done <"${raw_dir}/attempt-inventory.tsv"

gitleaks dir "${logs_dir}" \
  --redact=100 --no-banner --no-color --log-level=error \
  --max-archive-depth=3 --max-decode-depth=3 \
  --report-format=json --report-path="${raw_dir}/gitleaks-workflow-attempts.json" \
  --exit-code=0 \
  >"${raw_dir}/gitleaks-workflow-attempts.stdout.txt" \
  2>"${raw_dir}/gitleaks-workflow-attempts.stderr.txt"

jq 'map({
  ruleId: .RuleID,
  description: .Description,
  file: .File,
  startLine: .StartLine,
  fingerprint: .Fingerprint
})' "${raw_dir}/gitleaks-workflow-attempts.json" \
  >"${safe_dir}/workflow-attempt-findings.json"

rg -l -i --hidden --no-ignore \
  '(authorization:|bearer[[:space:]]+[A-Za-z0-9._~+/-]+|api[_-]?key|client[_-]?secret|private[_-]?key|password=|token=|secret=|github_token|aws_access_key|database_url|postgres://|mysql://|mongodb(\+srv)?://|https?://[^[:space:]]+:[^[:space:]@]+@)' \
  "${logs_dir}" >"${raw_dir}/pattern-matching-files.txt" || true

run_count="$(jq 'length' "${raw_dir}/workflow-runs.json")"
attempt_count="$(wc -l <"${raw_dir}/attempt-inventory.tsv" | tr -d ' ')"
downloaded_count="$(wc -l <"${raw_dir}/downloaded-attempt-logs.txt" | tr -d ' ')"
unavailable_count="$(wc -l <"${raw_dir}/unavailable-attempt-logs.txt" | tr -d ' ')"
finding_count="$(jq 'length' "${safe_dir}/workflow-attempt-findings.json")"
pattern_file_count="$(wc -l <"${raw_dir}/pattern-matching-files.txt" | tr -d ' ')"

jq -n \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg repository "${repo}" \
  --argjson workflowRuns "${run_count}" \
  --argjson enumeratedAttempts "${attempt_count}" \
  --argjson downloadedAttempts "${downloaded_count}" \
  --argjson unavailableAttempts "${unavailable_count}" \
  --argjson scannerFindings "${finding_count}" \
  --argjson patternMatchingFiles "${pattern_file_count}" \
  '{
    schemaVersion: 1,
    generatedAt: $generatedAt,
    repository: $repository,
    retainedEvidence: {
      workflowRuns: $workflowRuns,
      enumeratedAttempts: $enumeratedAttempts,
      downloadedAttempts: $downloadedAttempts,
      unavailableAttempts: $unavailableAttempts
    },
    automatedFindings: {
      gitleaks: $scannerFindings,
      patternMatchingFiles: $patternMatchingFiles
    },
    publicationApproved: false,
    note: "Every retained rerun attempt is enumerated separately. Unavailable attempts and all automated matches require manual classification."
  }' >"${safe_dir}/summary.json"

cat >"${safe_dir}/manual-review.md" <<'EOF'
# Manual workflow-attempt review

- Confirm every workflow run's `run_attempt` value is represented in `sensitive-raw/attempt-inventory.tsv`.
- Review every downloaded attempt separately; a later clean rerun does not clear an earlier disclosure.
- Confirm every unavailable attempt is expired or deleted rather than inaccessible because of missing authorization.
- Review the protected scanner output and every file listed by the pattern search.
- Never upload `sensitive-raw/` or quote secret values in issues, pull requests, workflow summaries, or artifacts.
EOF

printf 'Workflow-attempt audit written to %s\n' "${out_dir}"
printf 'Runs: %s; attempts: %s; downloaded: %s; unavailable: %s; scanner findings: %s\n' \
  "${run_count}" "${attempt_count}" "${downloaded_count}" "${unavailable_count}" "${finding_count}"

if (( unavailable_count > 0 || finding_count > 0 || pattern_file_count > 0 )); then
  echo 'Workflow attempts require classification; publication remains blocked.' >&2
  exit 1
fi

echo 'Automated workflow-attempt scans found no results. Manual review remains mandatory; publication is not approved.'