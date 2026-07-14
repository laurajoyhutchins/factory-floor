# Factory Floor

**A composable runtime for information work.**

Factory Floor is the product-facing implementation of the **Composable Agent Runtime**: a durable execution substrate built from explicit processing, coordination, storage, policy, and lifecycle primitives.

The first implementation is intentionally conservative. It is a transactional modular monolith that proves durable graph execution, immutable artifacts, provenance, retries, cancellation fencing, capabilities, policy decisions, and atomic result publication before adding distributed infrastructure or a visual builder.

## Start here

Read the design bundle in this order:

1. [`docs/specs/reference-implementation-v0.1.md`](docs/specs/reference-implementation-v0.1.md)
2. [`docs/specs/architecture-decisions-v0.1.md`](docs/specs/architecture-decisions-v0.1.md)
3. [`examples/investigation-system.yaml`](examples/investigation-system.yaml) — Milestone 1 static graph
4. [`examples/investigation-system-target.yaml`](examples/investigation-system-target.yaml) — later dynamic-region target
5. [`docs/product/operator-console-brief-v0.1.md`](docs/product/operator-console-brief-v0.1.md)
6. [`docs/plans/2026-07-14-factory-floor-mvp.md`](docs/plans/2026-07-14-factory-floor-mvp.md)
7. [`AGENTS.md`](AGENTS.md) and [`CODEX_KICKOFF_PROMPT.md`](CODEX_KICKOFF_PROMPT.md)

## Fixed stack

- Node.js 22 and TypeScript 5.x
- pnpm workspaces
- Python 3.12 with uv
- Fastify
- PostgreSQL 16 with Kysely and `pg`
- JSON Schema Draft 2020-12 with Ajv 8
- Pino and OpenTelemetry
- React 19, Vite, TanStack Query, and Server-Sent Events
- Vitest and pytest
- Docker Compose with PostgreSQL and MinIO for development

## Codespaces

The repository includes a development container with Node 22, Python 3.12, pnpm, uv, Docker-in-Docker, GitHub CLI, and an SSH server.

Create a Codespace from GitHub using **Code → Codespaces → Create codespace on main**, or from a machine with GitHub CLI:

```bash
gh codespace create -r laurajoyhutchins/factory-floor -b main
```

List and connect to it over SSH:

```bash
gh codespace list
gh codespace ssh
```

GitHub Codespaces creates the SSH authentication material automatically. No repository deploy key or committed private key is needed.

From Codex or another remote agent, use the Codespace selected by `gh codespace ssh` as the working machine and `/workspaces/factory-floor` as the repository root.

## Immediate target

Milestone 1 is a complete durable vertical slice:

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

The investigation example deliberately fails its first verification attempt, retries safely, preserves failed-attempt history and partial artifacts, and must not duplicate committed outputs.

## Core rules

- Workers propose; only the TypeScript control plane commits runtime truth.
- PostgreSQL is authoritative for coordination and metadata.
- Artifacts are immutable and content-addressed.
- Commands, events, deliveries, executions, and attempts remain distinct.
- Capabilities and policy decisions are enforced outside workers.
- The first UI is an operator console, not a drag-and-drop builder.
- Do not add Kafka, Temporal, Kubernetes operators, microservices, GraphQL, or dynamic child regions in Milestone 1.
