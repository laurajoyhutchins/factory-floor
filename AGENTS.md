# Factory Floor Agent Instructions

Treat the repository documents as authoritative and read them in this order before implementation work:

1. `README.md`
2. `docs/specs/reference-implementation-v0.1.md`
3. `docs/specs/architecture-decisions-v0.1.md`
4. `examples/investigation-system.yaml`
5. `examples/investigation-system-target.yaml`
6. `docs/product/operator-console-brief-v0.1.md`
7. `docs/plans/2026-07-14-factory-floor-mvp.md`
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

Do not create a second, unversioned copy of the setup logic in an agent prompt or environment UI. See `docs/development/environments.md` for the environment contract.

## Workspace maintenance

- Use `bash scripts/maintain-workspace.sh doctor` for non-destructive diagnosis.
- Use `bash scripts/maintain-workspace.sh all` after manifest or lockfile changes and before reporting the development environment healthy.
- Use `clean` only for transient build and test caches.
- Use `reset` only after identifying a damaged local dependency installation. Do not use it to conceal a reproducibility failure.
- The maintenance script must not modify Git state, delete `.env`, remove runtime data, or delete Docker volumes.

## Mission

Deliver Milestone 1, **Durable Reactive Graph**, as a complete tested vertical slice before expanding scope.

## Non-negotiable constraints

- Use Node.js 22, TypeScript 5.x, Python 3.12, pnpm, and uv.
- Keep the first implementation a transactional modular monolith.
- PostgreSQL is the authoritative coordination store.
- JSON Schema Draft 2020-12 is the language-neutral contract authority.
- Workers propose results; only the TypeScript control plane commits runtime truth.
- Artifacts are immutable and content-addressed.
- Preserve capability, provenance, lifecycle-epoch, retry-history, and atomic-commit semantics.
- Do not introduce Kafka, Temporal, Kubernetes operators, microservices, GraphQL, or a drag-and-drop builder in Milestone 1.
- Do not begin the visual console until the Milestone 1 acceptance scenario passes.

## Working method

- Work on a feature branch or isolated worktree.
- Follow the implementation plan task-by-task and update its checkboxes.
- Use test-driven development: failing test, minimal implementation, passing test, commit.
- Keep commits small, intentional, and conventional.
- Preserve module boundaries; unrelated modules must not query one another's tables directly.
- Resolve ordinary implementation details autonomously in favor of deterministic, strict, and testable behavior.
- Record design changes as ADRs.

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
