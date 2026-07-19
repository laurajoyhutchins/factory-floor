#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

repo_root="$(git rev-parse --show-toplevel)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
out_dir="${1:-${repo_root}/.factory-floor/publication-audit/history-${timestamp}}"
raw_dir="${out_dir}/sensitive-raw"
safe_dir="${out_dir}/sanitized"
mirror_dir="${raw_dir}/repository.git"
mkdir -p "${raw_dir}" "${safe_dir}"
chmod 700 "${out_dir}" "${raw_dir}" "${safe_dir}"

required=(git jq gitleaks trufflehog)
missing=()
for command_name in "${required[@]}"; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    missing+=("${command_name}")
  fi
done
if (( ${#missing[@]} > 0 )); then
  printf 'Missing required audit tools: %s\n' "${missing[*]}" >&2
  printf '%s\n' "${missing[@]}" >"${safe_dir}/missing-tools.txt"
  exit 2
fi

{
  git --version
  jq --version
  gitleaks version
  trufflehog --version
} >"${safe_dir}/tool-versions.txt" 2>&1

if [[ -n "$(git -C "${repo_root}" status --porcelain)" ]]; then
  echo 'Publication audit requires a clean working tree.' >&2
  exit 2
fi

if ! origin_url="$(git -C "${repo_root}" remote get-url origin)"; then
  echo 'Publication audit requires an authenticated origin remote.' >&2
  exit 2
fi

candidate_sha="$(git -C "${repo_root}" rev-parse HEAD)"
default_ref="$(git -C "${repo_root}" ls-remote --symref origin HEAD | awk '$1 == "ref:" { print $2; exit }')"
if [[ -z "${default_ref}" ]]; then
  echo 'Unable to resolve the remote default branch.' >&2
  exit 2
fi

git -C "${repo_root}" ls-remote origin | sort >"${raw_dir}/remote-refs-before.txt"
git clone --mirror "${origin_url}" "${mirror_dir}" \
  >"${raw_dir}/git-clone.stdout.txt" \
  2>"${raw_dir}/git-clone.stderr.txt"
git -C "${mirror_dir}" config remote.origin.fetch '+refs/*:refs/*'
git -C "${mirror_dir}" fetch --force --prune origin \
  >"${raw_dir}/git-fetch.stdout.txt" \
  2>"${raw_dir}/git-fetch.stderr.txt"

default_sha="$(git -C "${mirror_dir}" rev-parse "${default_ref}^{commit}")"
if [[ "${candidate_sha}" != "${default_sha}" && "${FACTORY_FLOOR_AUDIT_ALLOW_NONDEFAULT:-0}" != "1" ]]; then
  printf 'Candidate HEAD %s is not remote default branch %s at %s.\n' \
    "${candidate_sha}" "${default_ref}" "${default_sha}" >&2
  exit 2
fi

if ! git -C "${mirror_dir}" cat-file -e "${candidate_sha}^{commit}"; then
  echo 'Publication candidate is not reachable from the mirrored remote refs.' >&2
  exit 2
fi

git -C "${mirror_dir}" fsck --full >"${raw_dir}/git-fsck.txt" 2>&1

# Verify that every advertised named ref was captured at the same object ID.
: >"${raw_dir}/missing-or-mismatched-refs.txt"
while IFS=$'\t' read -r remote_sha remote_ref; do
  [[ -n "${remote_ref}" ]] || continue
  [[ "${remote_ref}" == "HEAD" ]] && continue
  [[ "${remote_ref}" == *'^{}' ]] && continue
  mirrored_sha="$(git -C "${mirror_dir}" rev-parse --verify "${remote_ref}" 2>/dev/null || true)"
  if [[ "${mirrored_sha}" != "${remote_sha}" ]]; then
    printf '%s\t%s\t%s\n' "${remote_ref}" "${remote_sha}" "${mirrored_sha:-missing}" \
      >>"${raw_dir}/missing-or-mismatched-refs.txt"
  fi
done <"${raw_dir}/remote-refs-before.txt"

ref_coverage_complete=true
if [[ -s "${raw_dir}/missing-or-mismatched-refs.txt" ]]; then
  ref_coverage_complete=false
fi

commit_count="$(git -C "${mirror_dir}" rev-list --all --count)"
ref_count="$(git -C "${mirror_dir}" show-ref | wc -l | tr -d ' ')"

# These files may contain personal information. Keep them local, mode 600, and
# never upload them to Actions artifacts or paste them into an issue or PR.
git -C "${mirror_dir}" show-ref >"${raw_dir}/refs.txt"
git -C "${mirror_dir}" log --all --date=iso-strict \
  --format='%H%x09%aN%x09%aE%x09%cN%x09%cE%x09%ad%x09%cd%x09%s' \
  >"${raw_dir}/commit-metadata.tsv"
git -C "${mirror_dir}" log --all --name-only --format= \
  | sed '/^$/d' | sort -u >"${raw_dir}/historical-paths.txt"

git -C "${mirror_dir}" rev-list --objects --all \
  | git -C "${mirror_dir}" cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
  | awk '$1 == "blob"' \
  | sort -k3,3nr >"${raw_dir}/all-blobs-by-size.txt"
head -n 200 "${raw_dir}/all-blobs-by-size.txt" >"${raw_dir}/largest-blobs.txt"

# File names can themselves disclose private information, so retain the full
# list only in the local sensitive directory and expose only the count below.
grep -Eai '(^|/)(\.env($|\.)|id_(rsa|ed25519)|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|sqlite|db|dump|bak|zip|tar|tgz|gz|7z|pdf)$|credentials?|secrets?|tokens?|private|customer|client)' \
  "${raw_dir}/historical-paths.txt" >"${raw_dir}/suspicious-paths.txt" || true

# Gitleaks output is fully redacted. The raw report is still treated as
# sensitive because paths, commit IDs, and surrounding metadata can disclose
# private context.
gitleaks git "${mirror_dir}" \
  --log-opts='--all --full-history' \
  --redact=100 \
  --no-banner \
  --no-color \
  --log-level=error \
  --report-format=json \
  --report-path="${raw_dir}/gitleaks.json" \
  --exit-code=0 \
  >"${raw_dir}/gitleaks.stdout.txt" \
  2>"${raw_dir}/gitleaks.stderr.txt"

jq 'map({
  ruleId: .RuleID,
  description: .Description,
  file: .File,
  startLine: .StartLine,
  commit: .Commit,
  fingerprint: .Fingerprint
})' "${raw_dir}/gitleaks.json" >"${safe_dir}/gitleaks-findings.json"

# TruffleHog JSON contains raw detector output. It must remain in the local
# sensitive directory. The sanitized derivative deliberately omits Raw,
# Redacted, author email, repository URL, and detector-specific ExtraData.
trufflehog git "file://${mirror_dir}" \
  --results=verified,unknown \
  --json \
  --no-update \
  >"${raw_dir}/trufflehog.ndjson" \
  2>"${raw_dir}/trufflehog.stderr.txt"

jq -s 'map({
  detectorName: .DetectorName,
  verified: .Verified,
  commit: .SourceMetadata.Data.Git.commit,
  file: .SourceMetadata.Data.Git.file,
  line: .SourceMetadata.Data.Git.line,
  timestamp: .SourceMetadata.Data.Git.timestamp
})' "${raw_dir}/trufflehog.ndjson" >"${safe_dir}/trufflehog-findings.json"

git -C "${repo_root}" ls-remote origin | sort >"${raw_dir}/remote-refs-after.txt"
remote_refs_stable=true
if ! cmp -s "${raw_dir}/remote-refs-before.txt" "${raw_dir}/remote-refs-after.txt"; then
  remote_refs_stable=false
  diff -u \
    "${raw_dir}/remote-refs-before.txt" \
    "${raw_dir}/remote-refs-after.txt" \
    >"${raw_dir}/remote-ref-changes.diff" || true
fi

gitleaks_count="$(jq 'length' "${safe_dir}/gitleaks-findings.json")"
trufflehog_count="$(jq 'length' "${safe_dir}/trufflehog-findings.json")"
suspicious_path_count="$(wc -l <"${raw_dir}/suspicious-paths.txt" | tr -d ' ')"
large_blob_count="$(awk '$3 >= 1048576 { count += 1 } END { print count + 0 }' "${raw_dir}/all-blobs-by-size.txt")"

jq -n \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg candidateSha "${candidate_sha}" \
  --arg defaultRef "${default_ref}" \
  --arg defaultSha "${default_sha}" \
  --argjson commitCount "${commit_count}" \
  --argjson refCount "${ref_count}" \
  --argjson refCoverageComplete "${ref_coverage_complete}" \
  --argjson gitleaksFindings "${gitleaks_count}" \
  --argjson trufflehogFindings "${trufflehog_count}" \
  --argjson suspiciousHistoricalPaths "${suspicious_path_count}" \
  --argjson blobsAtLeastOneMiB "${large_blob_count}" \
  --argjson remoteRefsStable "${remote_refs_stable}" \
  '{
    schemaVersion: 1,
    generatedAt: $generatedAt,
    candidateSha: $candidateSha,
    defaultRef: $defaultRef,
    defaultSha: $defaultSha,
    scope: "fresh mirror of every ref advertised by origin, including branches, tags, pull-request refs, notes, commits, deleted paths, and reachable blobs",
    commitCount: $commitCount,
    refCount: $refCount,
    refCoverageComplete: $refCoverageComplete,
    remoteRefsStable: $remoteRefsStable,
    automatedFindings: {
      gitleaks: $gitleaksFindings,
      trufflehogVerifiedOrUnknown: $trufflehogFindings,
      suspiciousHistoricalPaths: $suspiciousHistoricalPaths,
      blobsAtLeastOneMiB: $blobsAtLeastOneMiB
    },
    publicationApproved: false,
    note: "Automated scanning never approves publication. Every finding and all metadata, large blobs, binaries, archives, images, PDFs, and deleted paths require human classification."
  }' >"${safe_dir}/summary.json"

cat >"${safe_dir}/manual-review.md" <<EOF
# Manual publication review

Automated history scan completed for candidate \`${candidate_sha}\`.

- Confirm \`refCoverageComplete\` and \`remoteRefsStable\` are true. Otherwise freeze merges and rerun the entire audit.
- Review every entry in \`sensitive-raw/suspicious-paths.txt\`.
- Review \`sanitized/gitleaks-findings.json\` and the protected raw report.
- Review \`sanitized/trufflehog-findings.json\` and the protected raw report.
- Review the complete commit metadata for personal email addresses, private host names, account identifiers, local paths, customer data, copied conversations, and private project names.
- Review \`sensitive-raw/largest-blobs.txt\` and all non-text blobs, including every archive, image, screenshot, PDF, database, dump, generated report, and release asset.
- Classify every result as synthetic, false positive, expired, revoked, or active.
- Revoke or rotate real credentials before rewriting history.
- Repeat this scan after any rewrite and compare commit/ref coverage.

Do not upload \`sensitive-raw/\` or quote secret values in GitHub.
EOF

printf 'Publication history audit written to %s\n' "${out_dir}"
printf 'Gitleaks findings: %s; TruffleHog verified/unknown: %s; suspicious paths: %s\n' \
  "${gitleaks_count}" "${trufflehog_count}" "${suspicious_path_count}"

if [[ "${ref_coverage_complete}" != "true" ]]; then
  echo 'The mirror did not capture every advertised ref at the expected object ID.' >&2
  exit 3
fi

if [[ "${remote_refs_stable}" != "true" ]]; then
  echo 'Remote refs changed during the scan; publication evidence is inconsistent.' >&2
  exit 3
fi

if (( gitleaks_count > 0 || trufflehog_count > 0 )); then
  echo 'Automated credential findings require classification; publication remains blocked.' >&2
  exit 1
fi

echo 'Automated credential scanners found no results. Manual review remains mandatory; publication is not approved.'