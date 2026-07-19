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
