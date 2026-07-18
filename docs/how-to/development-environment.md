# Set up a reproducible development environment

**Type:** How-to
**Status:** Current

Use this guide to bootstrap a local or hosted checkout with the repository-supported Node.js, Python, pnpm, uv, PostgreSQL, and MinIO toolchain.

## Prerequisites

- Node.js 22
- Python 3.12
- Bash
- Docker Compose with a reachable Docker daemon for service-backed verification

GitHub Codespaces, Codex Cloud, and ordinary Linux hosts use the same repository-owned bootstrap path. Codex Cloud also uses `bash scripts/codex-cloud-setup.sh`; it may provide Docker CLI and Compose without a reachable daemon.

## Bootstrap the workspace

From the repository root, run:

```bash
bash scripts/bootstrap-workspace.sh
cp .env.example .env
pnpm services:up
pnpm services:wait
pnpm db:migrate
```

The bootstrap validates Node.js 22 and Python 3.12, activates the pinned pnpm version, installs or validates uv, and synchronizes dependencies from lockfiles when available. Keep `.env` local and never commit credentials, worker tokens, signed URLs, or production endpoints.

## Maintain the workspace

Use the repository-owned maintenance script:

```bash
bash scripts/maintain-workspace.sh doctor
bash scripts/maintain-workspace.sh all
```

Use `clean` only for transient build and test caches. Use `reset` only after diagnosing a damaged dependency installation. Maintenance does not modify Git state, delete `.env`, remove runtime data, or delete Docker volumes.

## Verify without Docker

Use the canonical fast stages for code and generated-content verification:

```bash
pnpm verify:static
pnpm verify:unit
pnpm verify:fast
```

`verify:static` validates contracts, generated-code drift, the conformance ledger, lint, types, and formatting. `verify:unit` runs the root TypeScript and TSX projects, locked Python tests, and the console production build. JavaScript unit tests run without inherited database URLs, so caller service configuration cannot silently turn them into integration tests. `verify:fast` runs both stages and is the closest local reproduction of the pull request's fast CI job.

The root Vitest project includes the console's `.test.tsx` component tests while preserving its jsdom setup. The root TypeScript project references the console, and the unit stage retains its production build as a permanent gate.

## Verify services and the complete repository

For service-backed verification, run the stages in order:

```bash
pnpm verify:services
pnpm verify:integration
pnpm verify:acceptance
pnpm services:clean
```

`verify:services` validates Compose, starts PostgreSQL and MinIO, waits for health, and runs migrations. `verify:integration` prepares workspace build output, runs Docker-backed integration and investigation-demo checks, runs conformance-focused tests, and resets the development database through the guarded command. `verify:acceptance` runs live-restart acceptance against the prepared services.

To run the complete sequence with automatic service cleanup, use:

```bash
pnpm verify
```

Set `FACTORY_FLOOR_VERIFY_CLEAN=1` only when you intentionally need fresh service volumes. See the [investigation run guide](run-investigation.md) for the operator-facing demo and inspection workflow.

## Environment boundaries

Docker Compose binds PostgreSQL, the MinIO API, and the MinIO console to loopback by default. Override bind addresses and ports only on a trusted development host. A reachable Docker daemon is required for PostgreSQL and MinIO integration tests.

When frozen installation fails, update the relevant manifest and lockfile together in one reviewed change. Do not work around reproducibility failures by copying setup commands into an agent prompt or environment UI.

## Troubleshooting

- If `pnpm install --frozen-lockfile` fails, inspect manifest and lockfile drift.
- If `uv sync --locked` fails, update the affected Python lockfile with its manifest change.
- If `pnpm services:wait` times out, run `pnpm services:status` and `pnpm services:logs`.
- If Docker works in Codespaces or CI but not Codex Cloud, use Codespaces or CI for service-backed verification.
- If worker authentication fails, ensure `.env` uses the same local value for `WORKER_API_BEARER_TOKEN` and `FACTORY_FLOOR_WORKER_TOKEN` and that the worker base URL matches the control plane.
