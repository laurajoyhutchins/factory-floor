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

## Verify dependencies and services

```bash
pnpm services:status
pnpm services:logs
pnpm contracts:validate
pnpm contracts:check
pnpm format:check
pnpm lint
pnpm typecheck
```

For service-backed verification, use `pnpm verify` or the [investigation run guide](run-investigation.md). Set `FACTORY_FLOOR_VERIFY_CLEAN=1` only when you intentionally need fresh service volumes.

## Environment boundaries

Docker Compose binds PostgreSQL, the MinIO API, and the MinIO console to loopback by default. Override bind addresses and ports only on a trusted development host. A reachable Docker daemon is required for PostgreSQL and MinIO integration tests.

When frozen installation fails, update the relevant manifest and lockfile together in one reviewed change. Do not work around reproducibility failures by copying setup commands into an agent prompt or environment UI.

## Troubleshooting

- If `pnpm install --frozen-lockfile` fails, inspect manifest and lockfile drift.
- If `uv sync --locked` fails, update the affected Python lockfile with its manifest change.
- If `pnpm services:wait` times out, run `pnpm services:status` and `pnpm services:logs`.
- If Docker works in Codespaces or CI but not Codex Cloud, use Codespaces or CI for service-backed verification.
- If worker authentication fails, ensure `.env` uses the same local value for `WORKER_API_BEARER_TOKEN` and `FACTORY_FLOOR_WORKER_TOKEN` and that the worker base URL matches the control plane.
