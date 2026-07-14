# Task 1 recovery

This branch recovers the valid monorepo scaffold from closed PR #1 and completes verification in GitHub Actions rather than relying on an ephemeral Codex Cloud workspace.

The recovery is intentionally evidence-driven:

- Node and Python dependencies are declared in repository manifests.
- CI regenerates both lockfiles, then verifies the frozen bootstrap path.
- TypeScript lint, typecheck, Vitest, and package-local tests run from repository-owned tooling.
- Python tests run from the uv-managed development dependency group.
- Docker Compose configuration is validated on a GitHub-hosted runner.
- PostgreSQL and MinIO must both report healthy before the workflow succeeds.

The document may be removed after the recovery PR is merged; its purpose is to preserve the rationale for the replacement branch.
