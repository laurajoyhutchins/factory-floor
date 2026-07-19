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
release_assets_dir="${raw_dir}/release-assets"
mkdir -p "${settings_dir}" "${logs_dir}" "${artifacts_dir}" "${release_assets_dir}" "${safe_dir}"
chmod 700 \
  "${out_dir}" \
  "${raw_dir}" \
  "${safe_dir}" \
  "${settings_dir}" \
  "${logs_dir}" \
  "${artifacts_dir}" \
  "${release_assets_dir}"

{
  gh --version | head -n 1
  jq --version
  python3 --version
  gitleaks version
  rg --version | head -n 1
} >"${safe_dir}/tool-versions.txt" 2>&1

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

stable_key() {
  python3 - "$1" <<'PY'
import hashlib
import sys
print(hashlib.sha256(sys.argv[1].encode("utf-8")).hexdigest())
PY
}

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

# Repository and protection snapshot. These files can reveal collaborators,
# private infrastructure names, and configuration details. Keep them local.
api_capture repository "repos/${repo}"
api_capture_pages branches "repos/${repo}/branches?per_page=100"
api_capture_pages rulesets "repos/${repo}/rulesets?includes_parents=true&per_page=100"
api_capture actions-permissions "repos/${repo}/actions/permissions"
api_capture actions-workflow-permissions "repos/${repo}/actions/permissions/workflow"
api_capture actions-fork-approval "repos/${repo}/actions/permissions/fork-pr-contributor-approval"
api_capture actions-selected "repos/${repo}/actions/permissions/selected-actions"
api_capture_pages actions-secrets "repos/${repo}/actions/secrets?per_page=100"
api_capture_pages actions-variables "repos/${repo}/actions/variables?per_page=100"
api_capture_pages dependabot-secrets "repos/${repo}/dependabot/secrets?per_page=100"
api_capture_pages codespaces-secrets "repos/${repo}/codespaces/secrets?per_page=100"
api_capture_pages environments "repos/${repo}/environments?per_page=100"
api_capture_pages webhooks "repos/${repo}/hooks?per_page=100"
api_capture_pages deploy-keys "repos/${repo}/keys?per_page=100"
api_capture_pages collaborators "repos/${repo}/collaborators?affiliation=all&per_page=100"
api_capture_pages runners "repos/${repo}/actions/runners?per_page=100"
api_capture_pages installations "repos/${repo}/installations?per_page=100"
api_capture_pages releases "repos/${repo}/releases?per_page=100"
api_capture pages "repos/${repo}/pages"
api_capture code-security-configuration "repos/${repo}/code-security-configuration"
api_capture private-vulnerability-reporting "repos/${repo}/private-vulnerability-reporting"

jq -r '.[]? | .[]? | select(.protected == true) | .name' "${settings_dir}/branches.json" \
  >"${raw_dir}/protected-branches.txt" || true
while IFS= read -r branch; do
  [[ -n "${branch}" ]] || continue
  encoded_branch="$(jq -nr --arg value "${branch}" '$value | @uri')"
  key="$(stable_key "${branch}")"
  api_capture "branch-protection-${key}" "repos/${repo}/branches/${encoded_branch}/protection"
done <"${raw_dir}/protected-branches.txt"

jq -r '.[]? | .[]? | .id // empty' "${settings_dir}/rulesets.json" \
  >"${raw_dir}/ruleset-ids.txt" || true
while IFS= read -r ruleset_id; do
  [[ -n "${ruleset_id}" ]] || continue
  api_capture "ruleset-${ruleset_id}" "repos/${repo}/rulesets/${ruleset_id}?includes_parents=true"
done <"${raw_dir}/ruleset-ids.txt"

jq -r '.[]?.environments[]?.name // empty' "${settings_dir}/environments.json" \
  >"${raw_dir}/environment-names.txt" || true
while IFS= read -r environment_name; do
  [[ -n "${environment_name}" ]] || continue
  encoded_environment="$(jq -nr --arg value "${environment_name}" '$value | @uri')"
  key="$(stable_key "${environment_name}")"
  api_capture "environment-${key}" "repos/${repo}/environments/${encoded_environment}"
  api_capture_pages "environment-${key}-secrets" "repos/${repo}/environments/${encoded_environment}/secrets?per_page=100"
  api_capture_pages "environment-${key}-variables" "repos/${repo}/environments/${encoded_environment}/variables?per_page=100"
done <"${raw_dir}/environment-names.txt"

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

: >"${raw_dir}/archive-validation-errors.txt"
: >"${raw_dir}/unavailable-workflow-logs.txt"
while IFS= read -r run_id; do
  [[ -n "${run_id}" ]] || continue
  zip_path="${logs_dir}/${run_id}.zip"
  extract_path="${logs_dir}/${run_id}"
  if gh api "repos/${repo}/actions/runs/${run_id}/logs" >"${zip_path}" 2>/dev/null; then
    if ! safe_extract_zip "${zip_path}" "${extract_path}" \
      2>>"${raw_dir}/archive-validation-errors.txt"; then
      printf '%s\tunsafe-or-invalid-archive\n' "${run_id}" >>"${raw_dir}/unavailable-workflow-logs.txt"
    fi
  else
    rm -f "${zip_path}"
    printf '%s\tunavailable-or-expired\n' "${run_id}" >>"${raw_dir}/unavailable-workflow-logs.txt"
  fi
done < <(jq -r '.[].id' "${raw_dir}/workflow-runs.json")

: >"${raw_dir}/unavailable-artifacts.txt"
while IFS= read -r artifact_id; do
  [[ -n "${artifact_id}" ]] || continue
  zip_path="${artifacts_dir}/${artifact_id}.zip"
  extract_path="${artifacts_dir}/${artifact_id}"
  if gh api "repos/${repo}/actions/artifacts/${artifact_id}/zip" >"${zip_path}" 2>/dev/null; then
    if ! safe_extract_zip "${zip_path}" "${extract_path}" \
      2>>"${raw_dir}/archive-validation-errors.txt"; then
      printf '%s\tunsafe-or-invalid-archive\n' "${artifact_id}" \
        >>"${raw_dir}/unavailable-artifacts.txt"
    fi
  else
    rm -f "${zip_path}"
    printf '%s\tunavailable-or-expired\n' "${artifact_id}" \
      >>"${raw_dir}/unavailable-artifacts.txt"
  fi
done < <(jq -r '.[].id' "${raw_dir}/artifacts.json")

: >"${raw_dir}/unavailable-release-assets.txt"
while IFS= read -r asset_id; do
  [[ -n "${asset_id}" ]] || continue
  asset_path="${release_assets_dir}/${asset_id}.asset"
  if ! gh api \
    -H 'Accept: application/octet-stream' \
    "repos/${repo}/releases/assets/${asset_id}" \
    >"${asset_path}" 2>/dev/null; then
    rm -f "${asset_path}"
    printf '%s\tunavailable\n' "${asset_id}" \
      >>"${raw_dir}/unavailable-release-assets.txt"
  fi
done < <(jq -r '.[]? | .[]? | .assets[]? | .id' "${settings_dir}/releases.json")

# Scan downloaded logs, workflow artifacts, and release assets without printing
# matches. Gitleaks redacts secret values; raw reports still remain protected
# because paths and context can be sensitive.
gitleaks dir "${logs_dir}" \
  --redact=100 --no-banner --no-color --log-level=error \
  --max-archive-depth=3 --max-decode-depth=3 \
  --report-format=json --report-path="${raw_dir}/gitleaks-workflow-logs.json" \
  --exit-code=0 \
  >"${raw_dir}/gitleaks-workflow-logs.stdout.txt" \
  2>"${raw_dir}/gitleaks-workflow-logs.stderr.txt"

gitleaks dir "${artifacts_dir}" \
  --redact=100 --no-banner --no-color --log-level=error \
  --max-archive-depth=5 --max-decode-depth=3 \
  --report-format=json --report-path="${raw_dir}/gitleaks-artifacts.json" \
  --exit-code=0 \
  >"${raw_dir}/gitleaks-artifacts.stdout.txt" \
  2>"${raw_dir}/gitleaks-artifacts.stderr.txt"

gitleaks dir "${release_assets_dir}" \
  --redact=100 --no-banner --no-color --log-level=error \
  --max-archive-depth=5 --max-decode-depth=3 \
  --report-format=json --report-path="${raw_dir}/gitleaks-release-assets.json" \
  --exit-code=0 \
  >"${raw_dir}/gitleaks-release-assets.stdout.txt" \
  2>"${raw_dir}/gitleaks-release-assets.stderr.txt"

jq 'map({ruleId: .RuleID, description: .Description, file: .File, startLine: .StartLine, fingerprint: .Fingerprint})' \
  "${raw_dir}/gitleaks-workflow-logs.json" >"${safe_dir}/workflow-log-findings.json"
jq 'map({ruleId: .RuleID, description: .Description, file: .File, startLine: .StartLine, fingerprint: .Fingerprint})' \
  "${raw_dir}/gitleaks-artifacts.json" >"${safe_dir}/artifact-findings.json"
jq 'map({ruleId: .RuleID, description: .Description, file: .File, startLine: .StartLine, fingerprint: .Fingerprint})' \
  "${raw_dir}/gitleaks-release-assets.json" >"${safe_dir}/release-asset-findings.json"

# This search records file names only. Review matches locally; do not quote the
# matching lines into the sanitized report.
rg -l -i --hidden --no-ignore \
  '(authorization:|bearer[[:space:]]+[A-Za-z0-9._~+/-]+|api[_-]?key|client[_-]?secret|private[_-]?key|password=|token=|secret=|github_token|aws_access_key|database_url|postgres://|mysql://|mongodb(\+srv)?://|https?://[^[:space:]]+:[^[:space:]@]+@)' \
  "${logs_dir}" "${artifacts_dir}" "${release_assets_dir}" \
  >"${raw_dir}/pattern-matching-files.txt" || true

run_count="$(jq 'length' "${raw_dir}/workflow-runs.json")"
artifact_count="$(jq 'length' "${raw_dir}/artifacts.json")"
cache_count="$(jq 'length' "${raw_dir}/caches.json")"
release_asset_count="$(jq '[.[]? | .[]? | .assets[]?] | length' "${settings_dir}/releases.json")"
log_findings="$(jq 'length' "${safe_dir}/workflow-log-findings.json")"
artifact_findings="$(jq 'length' "${safe_dir}/artifact-findings.json")"
release_asset_findings="$(jq 'length' "${safe_dir}/release-asset-findings.json")"
pattern_file_count="$(wc -l <"${raw_dir}/pattern-matching-files.txt" | tr -d ' ')"
unavailable_log_count="$(wc -l <"${raw_dir}/unavailable-workflow-logs.txt" | tr -d ' ')"
unavailable_artifact_count="$(wc -l <"${raw_dir}/unavailable-artifacts.txt" | tr -d ' ')"
unavailable_release_asset_count="$(wc -l <"${raw_dir}/unavailable-release-assets.txt" | tr -d ' ')"
ruleset_count="$(wc -l <"${raw_dir}/ruleset-ids.txt" | tr -d ' ')"
protected_branch_count="$(wc -l <"${raw_dir}/protected-branches.txt" | tr -d ' ')"

jq -n \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg repository "${repo}" \
  --argjson workflowRuns "${run_count}" \
  --argjson artifacts "${artifact_count}" \
  --argjson caches "${cache_count}" \
  --argjson releaseAssets "${release_asset_count}" \
  --argjson workflowLogFindings "${log_findings}" \
  --argjson artifactFindings "${artifact_findings}" \
  --argjson releaseAssetFindings "${release_asset_findings}" \
  --argjson patternMatchingFiles "${pattern_file_count}" \
  --argjson unavailableWorkflowLogs "${unavailable_log_count}" \
  --argjson unavailableArtifacts "${unavailable_artifact_count}" \
  --argjson unavailableReleaseAssets "${unavailable_release_asset_count}" \
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
      releaseAssets: $releaseAssets,
      unavailableWorkflowLogs: $unavailableWorkflowLogs,
      unavailableArtifacts: $unavailableArtifacts,
      unavailableReleaseAssets: $unavailableReleaseAssets
    },
    automatedFindings: {
      workflowLogs: $workflowLogFindings,
      artifacts: $artifactFindings,
      releaseAssets: $releaseAssetFindings,
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

- Review every downloaded workflow log, extracted workflow artifact, and release asset, including nested archives, screenshots, coverage, test reports, databases, environment files, generated documentation, and stack traces.
- Use the retained API metadata to map numeric evidence directories and files back to workflow artifact and release asset names.
- Review the protected raw scanner reports and every file listed by the pattern search.
- Confirm unavailable logs, workflow artifacts, or release assets are expired or deleted rather than inaccessible because of an authorization failure.
- Classify every Actions cache. Purge caches that may contain source, generated configuration, local paths, or private dependency material.
- Review workflow permissions, `pull_request_target`, reusable workflows, environments, OIDC, secret and variable names, self-hosted runners, installed apps, and fork approval policy.
- Review the complete settings snapshot before conversion. Immediately repeat this script after conversion and diff the settings directories.
- Recreate every disabled push ruleset and verify required checks, review requirements, force-push/deletion restrictions, and fork isolation with a harmless test PR.
- Never upload `sensitive-raw/` or paste secret values into an issue, pull request, workflow summary, or artifact.
EOF

printf 'GitHub publication audit written to %s\n' "${out_dir}"
printf 'Runs: %s; workflow artifacts: %s; release assets: %s; caches: %s; scanner findings: %s\n' \
  "${run_count}" \
  "${artifact_count}" \
  "${release_asset_count}" \
  "${cache_count}" \
  "$((log_findings + artifact_findings + release_asset_findings))"

if (( log_findings > 0 || artifact_findings > 0 || release_asset_findings > 0 || pattern_file_count > 0 )); then
  echo 'GitHub evidence requires classification; publication remains blocked.' >&2
  exit 1
fi

echo 'Automated GitHub evidence scans found no results. Manual evidence and configuration review remains mandatory; publication is not approved.'