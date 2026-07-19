# Factory Floor

**A composable runtime for information work.**

Factory Floor is the product-facing implementation of the **Composable Agent Runtime**: a durable execution substrate built from explicit processing, coordination, storage, policy, and lifecycle primitives.

The first implementation is intentionally conservative. It is a transactional modular monolith that proves durable graph execution, immutable artifacts, provenance, retries, cancellation fencing, capabilities, policy decisions, and atomic result publication before adding distributed infrastructure or a visual builder.

## Start here

Use the [documentation index](docs/README.md) for the authoritative reader-facing docs, organized by Diátaxis quadrant. The main entry points are:

1. [`docs/reference/runtime-contract.md`](docs/reference/runtime-contract.md)
2. [`docs/explanation/architecture.md`](docs/explanation/architecture.md)
3. [`docs/explanation/architecture-decisions.md`](docs/explanation/architecture-decisions.md)
4. [`examples/investigation-system.yaml`](examples/investigation-system.yaml) — Milestone 1 static graph
5. [`examples/investigation-system-target.yaml`](examples/investigation-system-target.yaml) — later dynamic-region target
6. [`docs/explanation/operator-console.md`](docs/explanation/operator-console.md)

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

## Reproducible environments

Codespaces, Codex Cloud, and ordinary Linux hosts share one versioned workspace bootstrap path:

```bash
bash scripts/bootstrap-workspace.sh
```

The script validates Node 22 and Python 3.12, activates pnpm 10.12.1, installs `uv`, uses lockfiles when present, synchronizes project dependencies, and prints the resolved environment.

See [`docs/how-to/development-environment.md`](docs/how-to/development-environment.md) for the full environment contract and troubleshooting guidance.

For environment setup, the investigation demo, inspection, artifact reconciliation, projection rebuild, troubleshooting, and publication readiness, see the [how-to guides](docs/README.md#how-to).

### Workspace maintenance

Routine inspection is non-destructive:

```bash
bash scripts/maintain-workspace.sh
```

Common maintenance commands are:

```bash
bash scripts/maintain-workspace.sh doctor
bash scripts/maintain-workspace.sh sync
bash scripts/maintain-workspace.sh verify
bash scripts/maintain-workspace.sh all
```

Cleanup and dependency reset are explicit rather than automatic:

```bash
bash scripts/maintain-workspace.sh clean
bash scripts/maintain-workspace.sh reset
```

Commands can be combined and run from left to right, for example:

```bash
bash scripts/maintain-workspace.sh clean sync verify
```

### Codex Cloud

Configure the Codex environment with Node 22 and Python 3.12.

Setup command:

```bash
bash scripts/codex-cloud-setup.sh
```

Maintenance command:

```bash
bash scripts/codex-cloud-maintenance.sh
```

These wrappers install the Docker CLI and Compose plugin before synchronizing the workspace. They do not install Docker Engine. `docker compose config` can therefore work even when the cloud sandbox does not expose a reachable daemon; confirm daemon access separately with `docker info`.

Keep the cloud configuration pointed at these repository scripts instead of copying setup commands into the environment UI. That keeps environment changes versioned and reviewable.

## Codespaces

The repository includes a development container with Node 22, Python 3.12, pnpm, uv, Docker-in-Docker, GitHub CLI, and an SSH server. Its post-create command delegates to the shared bootstrap.

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

## Current release

Milestone 1 is the released durable vertical slice:

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

## License, security, and publication

Factory Floor is licensed under the [Apache License, Version 2.0](LICENSE). Workspace packages remain marked private so publishing the repository does not publish packages to a registry.

Report suspected vulnerabilities through the private process in [SECURITY.md](SECURITY.md). Do not place credentials, private data, or exploit details in public issues or pull requests.

Bundled or adapted third-party material must be recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Before changing repository visibility, complete the fail-closed [publication audit](docs/how-to/publication-audit.md), including full-history secret and privacy scanning, retained Actions evidence review, license clearance, and post-conversion protection verification.