# Factory Floor Agent Instructions

Treat the repository documents as authoritative and read them in this order before implementation work:

1. `README.md`
2. `docs/reference/runtime-contract.md`
3. `docs/explanation/architecture-decisions.md`
4. `examples/investigation-system.yaml`
5. `examples/investigation-system-target.yaml`
6. `docs/explanation/operator-console.md`
7. `docs/README.md`
8. `CODEX_KICKOFF_PROMPT.md`

## Environment bootstrap

Before changing code, initialize or verify the workspace through the repository-owned setup path:

```bash
bash scripts/bootstrap-workspace.sh
```

Codex Cloud environments should configure their setup command as:

```bash
bash scripts/codex-cloud-setup.sh
```

Do not create a second, unversioned copy of the setup logic in an agent prompt or environment UI. See `docs/how-to/development-environment.md` for the environment contract.

## Workspace maintenance

- Use `bash scripts/maintain-workspace.sh doctor` for non-destructive diagnosis.
- Use `bash scripts/maintain-workspace.sh all` after manifest or lockfile changes and before reporting the development environment healthy.
- Use `clean` only for transient build and test caches.
- Use `reset` only after identifying a damaged local dependency installation. Do not use it to conceal a reproducibility failure.
- The maintenance script must not modify Git state, delete `.env`, remove runtime data, or delete Docker volumes.

## Mission

Maintain the accepted v0.1 **Durable Reactive Graph** baseline and scope new architecture work under Milestone 2 or later.

## Non-negotiable constraints

- Use Node.js 22, TypeScript 5.x, Python 3.12, pnpm, and uv.
- Keep the first implementation a transactional modular monolith.
- PostgreSQL is the authoritative coordination store.
- JSON Schema Draft 2020-12 is the language-neutral contract authority.
- Workers propose results; only the TypeScript control plane commits runtime truth.
- Artifacts are immutable and content-addressed.
- Preserve capability, provenance, lifecycle-epoch, retry-history, and atomic-commit semantics.
- Do not introduce Kafka, Temporal, Kubernetes operators, microservices, GraphQL, or a drag-and-drop builder in Milestone 1.
- Keep the released operator console read-only and preserve the Milestone 1 acceptance invariants while expanding scope.

## Working method

- Work on a feature branch or isolated worktree.
- Follow the current approved task plan task-by-task. Do not put active agent plans or scratch work under `docs/`.
- Use test-driven development: failing test, minimal implementation, passing test, commit.
- Keep commits small, intentional, and conventional.
- Preserve module boundaries; unrelated modules must not query one another's tables directly.
- Resolve ordinary implementation details autonomously in favor of deterministic, strict, and testable behavior.
- Record design changes as ADRs.

## Deciduous pilot

The Deciduous integration is a nonblocking development-history pilot. GitHub issues, ADRs, pull requests, and commits remain authoritative. Deciduous records only useful options, decisions, observations, pivots, and outcomes.

For a substantial pilot task, use the repository wrapper at three checkpoints:

```bash
bash scripts/deciduous-pilot.sh start "Goal tied to the issue or PR"
bash scripts/deciduous-pilot.sh decision "Chosen approach" "Why this approach was selected"
bash scripts/deciduous-pilot.sh observe "A discovery that changed or clarified the work"
bash scripts/deciduous-pilot.sh finish "Verified outcome" HEAD
bash scripts/deciduous-pilot.sh export "descriptive-graph-snapshot.json"
```

- Run `bash scripts/deciduous-pilot.sh recover` when resuming work after context loss.
- Record consequential reasoning, not routine edits, formatting, or repeated test commands.
- Never record secrets, credentials, private environment values, or hidden chain-of-thought.
- Do not run upstream `deciduous init` or `deciduous update`; they install generated assistant integrations outside this pilot's boundary.
- Do not block edits or commits when Deciduous is unavailable. Report the missing optional tool and continue the repository task.
- See `tools/deciduous/README.md` and issue #57 for installation, snapshot persistence, evaluation, and rollback.

Stop only for a direct contradiction between authoritative documents, an unavailable required credential or service, a change to an accepted invariant or ADR, or a potentially destructive external action.

## ChatGPT–GitHub operating protocol

### Delegation vocabulary

- **Take issue #N** — inspect current `main` and the issue, create an isolated branch, implement the complete accepted scope, open or update a draft pull request, perform a fresh self-review, resolve review and CI findings, verify the exact current head, and squash merge when every required gate is satisfied.
- **Review PR #N** — inspect the issue, complete diff, review threads, current-head CI, compatibility, failure semantics, security, and missing tests. Report findings only; do not modify or merge unless separately asked.
- **Fix PR #N** — work on the existing pull-request branch, address actionable findings, resolve appropriate review threads, and verify the exact current head. Do not merge.
- **Land PR #N** — review, fix anything necessary, verify the exact current head, then squash merge and close linked issues when safe.
- **Start open issues** — select the highest-leverage unblocked issues whose scopes and branches do not overlap. Respect dependency order and do not create competing implementations.

### Standing defaults

- Continue through ordinary implementation, self-review, CI-repair, and documentation loops without asking for repeated `continue` instructions.
- Resolve routine implementation choices autonomously in favor of deterministic, strict, least-privileged, and testable behavior.
- Never merge a stale or unverified head. Re-check the head SHA after every branch update, review fix, or CI rerun.
- Use squash merge for completed feature and maintenance pull requests unless the issue explicitly requires preserved commit structure.
- Do not expose secrets, credentials, private artifact bytes, or sensitive runtime data in chat, commits, logs, artifacts, or pull-request text.
- Stop for unavailable credentials, deployment or external side effects, destructive operations, accepted-invariant changes, unresolved architecture conflicts, or work that cannot be completed and verified within the available environment.

### Pull-request lifecycle

1. Start from current `main` or an explicitly approved stacked base and record the base SHA.
2. Keep the pull request in draft while behavior, tests, or self-review findings remain incomplete.
3. Implement test-first and retain red-state evidence in commit history, a focused log, or the pull-request narrative. Required CI must not remain intentionally red once an implementation is available.
4. Perform a fresh review from the issue and complete current diff rather than relying on the implementation conversation.
5. Resolve all actionable findings and explicitly defer only issue-linked work.
6. Require successful repository verification on the exact reviewed head.
7. Merge only when the sticky agent handoff, CI artifacts, and GitHub state all refer to that same head SHA.

### Durable handoff

- Keep the pull-request description current with scope, risk, invariants, verification, deferred work, and external blockers.
- The `Agent PR handoff` workflow owns one sticky status comment. Treat its JSON block as a resumable snapshot, not as approval.
- CI jobs must retain `agent-ci-summary.json` with the reviewed SHA, job, failed stage, first actionable error, reproduction command, artifact name, and run URL.
- Use the manual `Sync pull request branch` workflow for same-repository branch updates. It must never force-push or conceal conflicts.

## Completion evidence

Before claiming completion, run and report:

```bash
pnpm lint
pnpm typecheck
pnpm test
uv run --project packages/worker-sdk-py pytest
pnpm test:integration
```

Also provide end-to-end evidence for deliberate verifier failure and safe retry, preserved attempt history and partial artifacts, valid artifact digests/schemas/provenance, no duplicate committed outputs, attributable resource entries, reconstructable trace causation, and restart recovery without lost or duplicated work.
