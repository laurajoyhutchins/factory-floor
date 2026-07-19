#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

required=(gh jq unzip gitleaks rg)
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

gh auth status >/dev/null
repo="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
out_dir="${2:-${repo_root}/.factory-floor/publication-audit/github-${timestamp}}"
raw_dir="${out_dir}/sensitive-raw"
safe_dir="${out_dir}/sanitized"
settings_dir="${raw_dir}/settings"
logs_dir="${raw_dir}/workflow-logs"
artifacts_dir="${raw_dir}/workflow-artifacts"
mkdir -p "${settings_dir}" "${logs_dir}" "${artifacts_dir}" "${safe_dir}"
chmod 700 "${out_dir}" "${raw_dir}" "${safe_dir}" "${settings_dir}" "${logs_dir}" "${artifacts_dir}"

api_capture() {
  local name="$1"
  local endpoint="$2"
  if gh api "${endpoint}" >"${settings_dir}/${name}.json" 2>"${settings_dir}/${name}.error.txt"; then
    rm -f "${settings_dir}/${name}.error.txt"
    return 0
  fi
  jq -n --arg endpoint "${endpoint}" --arg status "unavailable" \
    '{endpoint: $endpoint, status: $status}' >"${settings_dir}/${name}.json"
  return 0
}

api_capture_pages() {
  local name="$1"
  local endpoint="$2"
  if gh api --paginate --slurp "${endpoint}" >"${settings_dir}/${name}.json" 2>"${settings_dir}/${name}.error.txt"; then
    rm -f "${settings_dir}/${name}.error.txt"
    return 0
  fi
  printf '[]\n' >"${settings_dir}/${name}.json"
  return 0
}

# Repository and protection snapshot. These files can reveal collaborators,
# private infrastructure names, and configuration details. Keep them local.
api_capture repository "repos/${repo}"
api_capture_pages branches "repos/${repo}/branches?per_page=100"
api_capture_pages rulesets "repos/${repo}/rulesets?includes_parents=true&per_page=100"
api_capture actions-permissions "repos/${repo}/actions/permissions"
api_capture actions-workflow-permissions "repos/${repo}/actions/permissions/workflow"
api_capture actions-fork-approval "repos/${repo}/actions/permissions/fork-pr-contributor-approval"
api_capture actions-selected "repos/${repo}/actions/permissions/selected-actions"
api_capture_pages environments "repos/${repo}/environments?per_page=100"
api_capture_pages webhooks "repos/${repo}/hooks?per_page=100"
api_capture_pages deploy-keys "repos/${repo}/keys?per_page=100"
api_capture_pages collaborators "repos/${repo}/collaborators?affiliation=all&per_page=100"
api_capture code-security-configuration "repos/${repo}/code-security-configuration"
api_capture private-vulnerability-reporting "repos/${repo}/private-vulnerability-reporting"

jq -r '.[]? | .[]? | select(.protected == true) | .name' "${settings_dir}/branches.json" \
  >"${raw_dir}/protected-branches.txt" || true
while IFS= read -r branch; do
  [[ -n "${branch}" ]] || continue
  encoded_branch="$(jq -nr --arg value "${branch}" '$value | @uri')"
  safe_name="$(printf '%s' "${branch}" | tr '/ ' '__')"
  api_capture "branch-protection-${safe_name}" "repos/${repo}/branches/${encoded_branch}/protection"
done <"${raw_dir}/protected-branches.txt"

jq -r '.[]? | .[]? | .id // empty' "${settings_dir}/rulesets.json" \
  >"${raw_dir}/ruleset-ids.txt" || true
while IFS= read -r ruleset_id; do
  [[ -n "${ruleset_id}" ]] || continue
  api_capture "ruleset-${ruleset_id}" "repos/${repo}/rulesets/${ruleset_id}?includes_parents=true"
done <"${raw_dir}/ruleset-ids.txt"

# Enumerate every retained workflow run, artifact, and cache visible through the
# API. Run and artifact payloads may contain private branch, actor, and path data.
gh api --paginate --slurp "repos/${repo}/actions/runs?per_page=100" \
  >"${raw_dir}/workflow-run-pages.json"
jq '[.[]?.workflow_runs[]?]' "${raw_dir}/workflow-run-pages.json" \
  >"${raw_dir}/workflow-runs.json"

gh api --paginate --slurp "repos/${repo}/actions/artifacts?per_page=100" \
  >"${raw_dir}/artifact-pages.json"
jq '[.[]?.artifacts[]?]' "${raw_dir}/artifact-pages.json" \
  >"${raw_dir}/artifacts.json"

if gh api --paginate --slurp "repos/${repo}/actions/caches?per_page=100" \
  >"${raw_dir}/cache-pages.json" 2>"${raw_dir}/cache-pages.error.txt"; then
  jq '[.[]?.actions_caches[]?]' "${raw_dir}/cache-pages.json" >"${raw_dir}/caches.json"
  rm -f "${raw_dir}/cache-pages.error.txt"
else
  printf '[]\n' >"${raw_dir}/caches.json"
fi

: >"${raw_dir}/unavailable-workflow-logs.txt"
while IFS= read -r run_id; do
  [[ -n "${run_id}" ]] || continue
  zip_path="${logs_dir}/${run_id}.zip"
  extract_path="${logs_dir}/${run_id}"
  if gh api "repos/${repo}/actions/runs/${run_id}/logs" >"${zip_path}" 2>/dev/null; then
    mkdir -p "${extract_path}"
    if ! unzip -qq -o "${zip_path}" -d "${extract_path}"; then
      printf '%s\tinvalid-archive\n' "${run_id}" >>"${raw_dir}/unavailable-workflow-logs.txt"
    fi
  else
    rm -f "${zip_path}"
    printf '%s\tunavailable-or-expired\n' "${run_id}" >>"${raw_dir}/unavailable-workflow-logs.txt"
  fi
done < <(jq -r '.[].id' "${raw_dir}/workflow-runs.json")

: >"${raw_dir}/unavailable-artifacts.txt"
while IFS=$'\t' read -r artifact_id artifact_name; do
  [[ -n "${artifact_id}" ]] || continue
  safe_name="$(printf '%s' "${artifact_name}" | tr -cs 'A-Za-z0-9._-' '_')"
  zip_path="${artifacts_dir}/${artifact_id}-${safe_name}.zip"
  extract_path="${artifacts_dir}/${artifact_id}-${safe_name}"
  if gh api "repos/${repo}/actions/artifacts/${artifact_id}/zip" >"${zip_path}" 2>/dev/null; then
    mkdir -p "${extract_path}"
    if ! unzip -qq -o "${zip_path}" -d "${extract_path}"; then
      printf '%s\t%s\tinvalid-archive\n' "${artifact_id}" "${artifact_name}" \
        >>"${raw_dir}/unavailable-artifacts.txt"
    fi
  else
    rm -f "${zip_path}"
    printf '%s\t%s\tunavailable-or-expired\n' "${artifact_id}" "${artifact_name}" \
      >>"${raw_dir}/unavailable-artifacts.txt"
  fi
done < <(jq -r '.[] | [.id, .name] | @tsv' "${raw_dir}/artifacts.json")

# Scan downloaded logs and artifacts without printing matches. Gitleaks redacts
# secret values; raw reports still remain protected because paths and context
# can be sensitive.
gitleaks dir "${logs_dir}" \
  --redact=100 --no-banner --no-color --log-level=error \
  --max-archive-depth=3 --max-decode-depth=3 \
  --report-format=json --report-path="${raw_dir}/gitleaks-workflow-logs.json" \
  --exit-code=0

gitleaks dir "${artifacts_dir}" \
  --redact=100 --no-banner --no-color --log-level=error \
  --max-archive-depth=5 --max-decode-depth=3 \
  --report-format=json --report-path="${raw_dir}/gitleaks-artifacts.json" \
  --exit-code=0

jq 'map({ruleId: .RuleID, description: .Description, file: .File, startLine: .StartLine, fingerprint: .Fingerprint})' \
  "${raw_dir}/gitleaks-workflow-logs.json" >"${safe_dir}/workflow-log-findings.json"
jq 'map({ruleId: .RuleID, description: .Description, file: .File, startLine: .StartLine, fingerprint: .Fingerprint})' \
  "${raw_dir}/gitleaks-artifacts.json" >"${safe_dir}/artifact-findings.json"

# This search records file names only. Review matches locally; do not quote the
# matching lines into the sanitized report.
rg -l -i --hidden --no-ignore \
  '(authorization:|bearer[[:space:]]+[A-Za-z0-9._~+/-]+|api[_-]?key|client[_-]?secret|private[_-]?key|password=|token=|secret=|github_token|aws_access_key|database_url|postgres://|mysql://|mongodb(\+srv)?://|https?://[^[:space:]]+:[^[:space:]@]+@)' \
  "${logs_dir}" "${artifacts_dir}" >"${raw_dir}/pattern-matching-files.txt" || true

run_count="$(jq 'length' "${raw_dir}/workflow-runs.json")"
artifact_count="$(jq 'length' "${raw_dir}/artifacts.json")"
cache_count="$(jq 'length' "${raw_dir}/caches.json")"
log_findings="$(jq 'length' "${safe_dir}/workflow-log-findings.json")"
artifact_findings="$(jq 'length' "${safe_dir}/artifact-findings.json")"
pattern_file_count="$(wc -l <"${raw_dir}/pattern-matching-files.txt" | tr -d ' ')"
unavailable_log_count="$(wc -l <"${raw_dir}/unavailable-workflow-logs.txt" | tr -d ' ')"
unavailable_artifact_count="$(wc -l <"${raw_dir}/unavailable-artifacts.txt" | tr -d ' ')"
ruleset_count="$(wc -l <"${raw_dir}/ruleset-ids.txt" | tr -d ' ')"
protected_branch_count="$(wc -l <"${raw_dir}/protected-branches.txt" | tr -d ' ')"

jq -n \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg repository "${repo}" \
  --argjson workflowRuns "${run_count}" \
  --argjson artifacts "${artifact_count}" \
  --argjson caches "${cache_count}" \
  --argjson workflowLogFindings "${log_findings}" \
  --argjson artifactFindings "${artifact_findings}" \
  --argjson patternMatchingFiles "${pattern_file_count}" \
  --argjson unavailableWorkflowLogs "${unavailable_log_count}" \
  --argjson unavailableArtifacts "${unavailable_artifact_count}" \
  --argjson rulesets "${ruleset_count}" \
  --argjson protectedBranches "${protected_branch_count}" \
  '{
    schemaVersion: 1,
    generatedAt: $generatedAt,
    repository: $repository,
    retainedEvidence: {
      workflowRuns: $workflowRuns,
      artifacts: $artifacts,
      caches: $caches,
      unavailableWorkflowLogs: $unavailableWorkflowLogs,
      unavailableArtifacts: $unavailableArtifacts
    },
    automatedFindings: {
      workflowLogs: $workflowLogFindings,
      artifacts: $artifactFindings,
      patternMatchingFiles: $patternMatchingFiles
    },
    protectionSnapshot: {
      rulesets: $rulesets,
      protectedBranches: $protectedBranches
    },
    publicationApproved: false,
    note: "The snapshot and automated scans require manual review. Caches cannot be downloaded through this audit and must be classified or purged before publication."
  }' >"${safe_dir}/summary.json"

cat >"${safe_dir}/manual-review.md" <<'EOF'
# Manual GitHub publication review

- Review every downloaded workflow log and every extracted artifact, including nested archives, screenshots, coverage, test reports, databases, environment files, generated documentation, and stack traces.
- Review the protected raw scanner reports and every file listed by the pattern search.
- Confirm unavailable logs or artifacts are expired or deleted rather than inaccessible because of an authorization failure.
- Classify every Actions cache. Purge caches that may contain source, generated configuration, local paths, or private dependency material.
- Review workflow permissions, `pull_request_target`, reusable workflows, environments, OIDC, secrets and variable names, self-hosted runners, and fork approval policy.
- Review the complete settings snapshot before conversion. Immediately repeat this script after conversion and diff the settings directories.
- Recreate every disabled push ruleset and verify required checks, review requirements, force-push/deletion restrictions, and fork isolation with a harmless test PR.
- Never upload `sensitive-raw/` or paste secret values into an issue, pull request, workflow summary, or artifact.
EOF

printf 'GitHub publication audit written to %s\n' "${out_dir}"
printf 'Runs: %s; artifacts: %s; caches: %s; scanner findings: %s\n' \
  "${run_count}" "${artifact_count}" "${cache_count}" "$((log_findings + artifact_findings))"

if (( log_findings > 0 || artifact_findings > 0 || pattern_file_count > 0 )); then
  echo 'Actions evidence requires classification; publication remains blocked.' >&2
  exit 1
fi

echo 'Automated Actions scans found no results. Manual evidence and configuration review remains mandatory; publication is not approved.'