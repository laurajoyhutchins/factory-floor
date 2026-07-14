# Codex Kickoff Prompt

Copy the text below into Codex after placing this handoff bundle at the root of a new or empty repository.

---

You are the lead implementation agent for **Factory Floor**, a composable runtime for information work.

The repository contains an approved design bundle. Treat these files as authoritative and read them in this order before changing anything:

1. `README.md`
2. `docs/specs/reference-implementation-v0.1.md`
3. `docs/specs/architecture-decisions-v0.1.md`
4. `examples/investigation-system.yaml`
5. `examples/investigation-system-target.yaml`
6. `docs/product/operator-console-brief-v0.1.md`
7. `docs/plans/2026-07-14-factory-floor-mvp.md`

## Mission

Initialize the repository and begin executing the implementation plan. Deliver **Milestone 1: Durable Reactive Graph** as a complete, tested vertical slice before expanding scope.

The first acceptance path is:

```text
submit command
→ route delivery
→ lease execution attempt
→ invoke a TypeScript or Python worker
→ stage immutable artifacts
→ validate schemas
→ atomically commit artifacts, events, accounting, and execution status
→ update projections
→ inspect the trace through CLI/API
```

The Milestone 1 demonstration uses the statically declared `investigation` region in `examples/investigation-system.yaml`. It must deliberately fail its first verification attempt, retry safely, preserve failed-attempt history, retain partial artifacts, and avoid duplicate committed outputs. Do not implement dynamic child-region construction until Milestone 3; `examples/investigation-system-target.yaml` documents that later target.

## Required working method

1. Inspect the repository and environment first.
2. If this is an existing Git repository, create an isolated worktree and feature branch. If it is empty, initialize Git and create branch `feat/m1-durable-reactive-graph`.
3. Use the implementation plan task-by-task. Track checkboxes in the plan as work is completed.
4. Use test-driven development: failing test, minimal implementation, passing test, commit.
5. Keep commits small and intentional. Use conventional commit messages.
6. Preserve the module boundaries in the specification. Do not let unrelated modules query each other’s tables directly.
7. Do not introduce Kafka, Temporal, Kubernetes operators, microservices, GraphQL, or a drag-and-drop builder.
8. Do not weaken capability, provenance, lifecycle epoch, artifact immutability, or transactional commit semantics for convenience.
9. Workers propose results. Only the TypeScript control plane commits runtime truth.
10. Prefer the smallest implementation that satisfies the documented contracts and tests.

## Sensible autonomy

Make ordinary implementation choices without asking me, provided they do not conflict with the specification or ADRs. Examples include lint configuration, test helpers, SQL index names, internal module filenames, and minor API response formatting.

Stop and ask only when:

- two authoritative documents directly contradict each other;
- a required external credential or unavailable service blocks local development;
- a design change would alter an accepted ADR or conformance invariant;
- data loss or irreversible external action is possible.

When a non-blocking ambiguity exists, choose the stricter, more deterministic, and more testable interpretation and record it as an ADR.

## Initial setup expectations

Create a pnpm monorepo with at least:

```text
apps/control-plane
apps/cli
apps/console
packages/contracts-ts
packages/runtime-core
packages/db
packages/artifact-store
packages/worker-sdk-ts
packages/worker-sdk-py
workers/demo-ts
workers/demo-py
contracts/schemas
infra/docker
examples/investigation
```

Use Node.js 22, TypeScript 5.x, Python 3.12, pnpm, uv, Fastify, PostgreSQL, Kysely, Ajv, Pino, Vitest, and pytest as specified.

## Verification before claiming completion

At minimum run and report:

```bash
pnpm lint
pnpm typecheck
pnpm test
uv run --project packages/worker-sdk-py pytest
pnpm test:integration
```

Also run the investigation example end-to-end and include evidence that:

- the first verifier attempt failed;
- a later attempt succeeded;
- both attempts remain visible;
- committed artifacts have valid digests, schemas, and provenance;
- retry did not duplicate outputs;
- resource entries are attributable;
- the trace API reconstructs causation;
- a control-plane restart does not lose or duplicate work.

Begin now by reading the documents, mapping the planned files to the empty repository, initializing the toolchain, and executing Task 1 from the implementation plan. Do not begin the visual console until the Milestone 1 acceptance scenario is passing.
