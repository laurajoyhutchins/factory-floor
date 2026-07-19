# Contributing to Factory Floor

Factory Floor accepts focused contributions that preserve its documented authority boundaries, durable-state semantics, and verification discipline.

## Before starting

Read:

1. `README.md`
2. `AGENTS.md`
3. `docs/reference/runtime-contract.md`
4. `docs/explanation/architecture-decisions.md`
5. the issue or accepted plan governing the change

Open or confirm an issue before substantial work so scope, compatibility, and architecture implications are visible. Security reports are the exception: follow `SECURITY.md` and do not disclose vulnerability details publicly.

## Development setup

Use Node.js 22, Python 3.12, pnpm, and uv. Initialize the repository through its versioned setup path:

```bash
bash scripts/bootstrap-workspace.sh
```

Work on a feature branch or isolated worktree. Keep commits small, intentional, and conventional. Do not include credentials, private data, generated runtime state, or unrelated cleanup.

## Implementation expectations

- Prefer test-driven changes: failing test, minimal implementation, passing test.
- Preserve existing public, worker, operator, schema, and SDK compatibility unless the accepted issue explicitly changes it.
- Document durable-state, transaction, retry, cancellation, replay, and recovery effects.
- Keep authority, capability, policy, and external-action enforcement outside untrusted workers.
- Record architecture changes as ADRs.
- Identify copied, adapted, generated, or bundled third-party material and update `THIRD_PARTY_NOTICES.md` when redistribution or attribution requires it.

## Verification

Before requesting review, run the checks relevant to the change and, for repository-wide changes, the complete verification sequence:

```bash
pnpm lint
pnpm typecheck
pnpm test
uv run --project packages/worker-sdk-py pytest
pnpm test:integration
```

Use the pull-request template to record exact commands, results, affected invariants, failure semantics, compatibility, risk, and deferred work. Required checks must pass on the exact reviewed head SHA.

## Review and merge

A pull request is not ready solely because CI is green. It must also have a fresh review of the complete current diff, no unresolved actionable review threads, and evidence that the successful required checks refer to the reviewed head.

Completed feature and maintenance pull requests are normally squash-merged. Force pushes, direct pushes to protected branches, and history rewrites are not part of the ordinary contribution workflow.

## Contribution license

Unless you explicitly state otherwise, contributions intentionally submitted for inclusion in Factory Floor are provided under the Apache License, Version 2.0, without additional terms. Mark material that is not a contribution clearly and do not submit code or assets you do not have the right to license.
