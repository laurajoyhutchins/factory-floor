#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

repo_root="$(git rev-parse --show-toplevel)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
out_dir="${1:-${repo_root}/.factory-floor/publication-audit/history-${timestamp}}"
raw_dir="${out_dir}/sensitive-raw"
safe_dir="${out_dir}/sanitized"
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

if ! git -C "${repo_root}" remote get-url origin >/dev/null 2>&1; then
  echo 'Publication audit requires an authenticated origin remote.' >&2
  exit 2
fi

git -C "${repo_root}" ls-remote origin | sort >"${raw_dir}/remote-refs-before.txt"

if [[ "$(git -C "${repo_root}" rev-parse --is-shallow-repository)" == "true" ]]; then
  git -C "${repo_root}" fetch --unshallow origin
fi

git -C "${repo_root}" fetch --force --prune origin \
  '+refs/heads/*:refs/remotes/origin/*' \
  '+refs/tags/*:refs/tags/*' \
  '+refs/pull/*/head:refs/remotes/origin/pull/*' \
  '+refs/pull/*/merge:refs/remotes/origin/pull-merge/*' \
  '+refs/notes/*:refs/notes/*'

if [[ "$(git -C "${repo_root}" rev-parse --is-shallow-repository)" != "false" ]]; then
  echo 'Publication audit requires a complete, non-shallow clone.' >&2
  exit 2
fi

head_sha="$(git -C "${repo_root}" rev-parse HEAD)"
commit_count="$(git -C "${repo_root}" rev-list --all --count)"
ref_count="$(git -C "${repo_root}" show-ref | wc -l | tr -d ' ')"

# These files may contain personal information. Keep them local, mode 600, and
# never upload them to Actions artifacts or paste them into an issue or PR.
git -C "${repo_root}" show-ref >"${raw_dir}/refs.txt"
git -C "${repo_root}" log --all --date=iso-strict \
  --format='%H%x09%aN%x09%aE%x09%cN%x09%cE%x09%ad%x09%cd%x09%s' \
  >"${raw_dir}/commit-metadata.tsv"
git -C "${repo_root}" log --all --name-only --format= \
  | sed '/^$/d' | sort -u >"${raw_dir}/historical-paths.txt"

git -C "${repo_root}" rev-list --objects --all \
  | git -C "${repo_root}" cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
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
gitleaks git "${repo_root}" \
  --log-opts='--all --full-history' \
  --redact=100 \
  --no-banner \
  --no-color \
  --log-level=error \
  --report-format=json \
  --report-path="${raw_dir}/gitleaks.json" \
  --exit-code=0

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
(
  cd "$(dirname "${repo_root}")"
  trufflehog git "file://$(basename "${repo_root}")" \
    --results=verified,unknown \
    --json \
    --no-update \
    >"${raw_dir}/trufflehog.ndjson"
)

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
  --arg headSha "${head_sha}" \
  --argjson commitCount "${commit_count}" \
  --argjson refCount "${ref_count}" \
  --argjson gitleaksFindings "${gitleaks_count}" \
  --argjson trufflehogFindings "${trufflehog_count}" \
  --argjson suspiciousHistoricalPaths "${suspicious_path_count}" \
  --argjson blobsAtLeastOneMiB "${large_blob_count}" \
  --argjson remoteRefsStable "${remote_refs_stable}" \
  '{
    schemaVersion: 1,
    generatedAt: $generatedAt,
    headSha: $headSha,
    scope: "all fetched branches, tags, pull-request heads and merge refs, notes, commits, deleted paths, and reachable blobs",
    commitCount: $commitCount,
    refCount: $refCount,
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

Automated history scan completed at \`${head_sha}\`.

- Confirm \`remoteRefsStable\` is true. If it is false, freeze merges and rerun the entire audit.
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

if [[ "${remote_refs_stable}" != "true" ]]; then
  echo 'Remote refs changed during the scan; publication evidence is inconsistent.' >&2
  exit 3
fi

if (( gitleaks_count > 0 || trufflehog_count > 0 )); then
  echo 'Automated credential findings require classification; publication remains blocked.' >&2
  exit 1
fi

echo 'Automated credential scanners found no results. Manual review remains mandatory; publication is not approved.'