# Audit Factory Floor before making it public

Repository publication is a disclosure operation, not a routine settings change. Keep the repository private until the complete history, retained GitHub evidence, licensing, third-party material, and repository protections have all been reviewed and the final decision is recorded in issue #75.

GitHub documents that changing a private repository to public makes its code, Actions history, and logs visible, allows anyone to fork it, and disables all push rulesets. The audit therefore has mandatory pre-change and post-change phases.

## Rules

- Do not change visibility while this procedure has an unresolved blocker.
- Do not upload raw scanner reports, downloaded logs, extracted artifacts, settings snapshots, or discovered secret values.
- Revoke or rotate a real credential before removing it from history, logs, or artifacts.
- Treat deleted paths, commit metadata, issue and pull-request attachments, screenshots, archives, and binary blobs as reviewable publication material.
- Automated scans can block publication but cannot approve it.

## Prerequisites

Use a trusted workstation or Codespace with authenticated access to the private repository. The following commands must be available:

```text
git
gh
jq
python3
rg
gitleaks
trufflehog
pnpm
uv
```

The collectors write their tool versions into the local evidence bundle. Preserve that file with the final audit record.

## 1. Freeze the publication candidate

Pause merges while the final scan runs. Record the candidate commit:

```bash
git fetch origin main --tags
git switch main
git pull --ff-only
git status --short
git rev-parse HEAD
```

The working tree must be clean. Do not reuse evidence generated for an earlier SHA.

## 2. Scan every reachable Git object

Run:

```bash
bash scripts/audit-publication-history.sh
```

The script creates an isolated fresh mirror of every ref advertised by `origin`, verifies the candidate is the remote default-branch commit, checks that the mirror captured every advertised ref at the expected object ID, verifies that remote refs did not move during the scan, runs Git object integrity checks, scans the mirrored history with Gitleaks and TruffleHog, and inventories commit metadata, historical paths, and reachable blobs.

Local evidence is written below:

```text
.factory-floor/publication-audit/history-<UTC timestamp>/
```

The `sensitive-raw/` directory includes the private mirror and may contain secret values, personal information, private paths, and credential-validation metadata. Never upload it. The `sanitized/` directory omits secret values but still requires review before sharing.

Manually inspect:

- every scanner result;
- author and committer names and email addresses;
- commit messages and branch and tag names;
- deleted files and suspicious historical paths;
- large and non-text blobs;
- archives, PDFs, screenshots, images, databases, dumps, coverage, generated reports, and release assets;
- private host names, URLs, IP addresses, account IDs, Codespace names, local paths, customer or client data, copied conversations, and private project names.

Classify every result. Synthetic fixtures and false positives must be documented without quoting sensitive values. Active, expired, or uncertain real credentials must be revoked or rotated. Rewrite history only after credential invalidation, then repeat the complete scan against the rewritten refs.

## 3. Audit retained GitHub evidence and snapshot protections

Run the complete collector:

```bash
bash scripts/audit-publication-github-all.sh laurajoyhutchins/factory-floor
```

The collector:

- enumerates retained workflow runs, every numbered rerun attempt, workflow artifacts, cache metadata, releases, and release assets;
- downloads every retained workflow-attempt log, workflow artifact, and release asset available through the API;
- rejects unsafe ZIP paths, symbolic links, excessive entry counts, and excessive expansion before extracting workflow evidence;
- scans downloaded evidence without printing matching content;
- snapshots repository metadata, rulesets, branch protection, Actions permissions, fork approval policy, repository and environment secret and variable names, environments, runners, installed apps, webhooks, deploy keys, collaborators, Pages, code-security configuration, and private vulnerability reporting;
- expands repository rulesets, protected-branch settings, and environment settings into individual files.

Evidence is written below:

```text
.factory-floor/publication-audit/github-complete-<UTC timestamp>/
```

Review every downloaded attempt separately: a later clean rerun does not clear a disclosure in an earlier attempt. Review every workflow artifact and release asset manually. Confirm unavailable items are expired or deleted rather than inaccessible because of an authorization problem. Actions caches cannot be downloaded by this audit; classify or purge them before publication.

Pay particular attention to `.github/workflows/agent-pr-handoff.yml`. It uses `pull_request_target`, so verify that it always checks out trusted default-branch code, never executes pull-request-controlled code with elevated permissions, and remains safe for public forks.

## 4. Verify licensing and redistribution rights

Factory Floor uses the Apache License, Version 2.0. Confirm that `LICENSE`, `NOTICE`, package metadata, release assets, and documentation consistently identify that license.

Generate dependency evidence locally:

```bash
mkdir -p .factory-floor/publication-audit/licenses
pnpm licenses list --json \
  > .factory-floor/publication-audit/licenses/pnpm-licenses.json
uv export --project packages/contracts-py --format cyclonedx1.5 \
  --output-file .factory-floor/publication-audit/licenses/contracts-py-sbom.json
uv export --project packages/worker-sdk-py --format cyclonedx1.5 \
  --output-file .factory-floor/publication-audit/licenses/worker-sdk-py-sbom.json
uv export --project workers/demo-py --format cyclonedx1.5 \
  --output-file .factory-floor/publication-audit/licenses/demo-py-sbom.json
```

Review unknown, custom, source-available, copyleft, non-commercial, attribution-required, and license-expression results. Confirm the license of every GitHub Action pinned by commit SHA.

Complete `THIRD_PARTY_NOTICES.md` for copied, adapted, bundled, or redistributed material. Do not treat an empty registry as evidence that no third-party material exists.

## 5. Review publication-facing content

Review the current and historical content of:

- README and all documentation;
- examples, fixtures, schemas, generated contracts, and acceptance evidence;
- issues, pull requests, reviews, comments, discussions, releases, tags, and attachments;
- issue and pull-request templates, contribution guidance, security policy, support statements, and roadmap language;
- repository description, homepage, topics, social preview, and branding.

The example environment uses unmistakable `change_me_...` disposable values. Confirm no historical example value was ever reused outside disposable local or CI environments.

## 6. Record the pre-change protection baseline

Preserve the entire `sensitive-raw/settings/` snapshot from the GitHub audit outside the repository. Record:

- every ruleset, bypass actor, target, condition, and rule;
- required status-check names;
- review and conversation-resolution requirements;
- linear-history, signed-commit, force-push, deletion, and tag restrictions;
- merge methods, auto-merge, default branch, and head-branch deletion;
- Actions permissions, default token permissions, allowed actions, fork approval, and retention;
- environments, deployment rules, secret and variable names, runners, webhooks, deploy keys, apps, collaborators, and Codespaces settings;
- dependency graph, Dependabot, secret scanning, push protection, code scanning, advisories, and private vulnerability reporting.

The visibility change must not begin until the exact recreation plan for every push ruleset is prepared.

## 7. Make the one-time visibility change

Record explicit go/no-go approval in issue #75. Change visibility only after every blocker is closed.

Immediately after conversion:

1. rerun `scripts/audit-publication-github-all.sh`;
2. diff the complete settings snapshots;
3. recreate every push ruleset GitHub disabled;
4. verify required checks resolve on a new harmless pull request;
5. verify direct pushes, force pushes, branch deletion, and unreviewed merges are blocked as intended;
6. verify a fork pull request cannot access repository secrets or privileged workflows;
7. re-enable or reconfigure public-repository security features;
8. record the public commit SHA and accepted residual risks in issue #75.

Publication is complete only when the post-change tests prove that the intended protections are active.
