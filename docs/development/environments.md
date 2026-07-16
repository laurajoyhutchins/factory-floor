# Reproducible Development Environments

Factory Floor uses repository-owned entrypoints for Codespaces, Codex Cloud, and ordinary Linux development hosts.

## Environment contract

The base environment must provide:

- Bash, Git, and curl;
- Node.js 22 with Corepack;
- Python 3.12.

The shared workspace bootstrap then:

1. validates the Node and Python major/minor versions;
2. adds `$HOME/.local/bin` to the current and future shell environment;
3. installs `uv` when missing;
4. activates pnpm 10.12.1 through Corepack;
5. installs JavaScript dependencies from `pnpm-lock.yaml` when present;
6. synchronizes root and Python worker projects when their `pyproject.toml` files exist;
7. marks the checkout as a safe Git directory;
8. prints the resolved toolchain versions.

The shared command is:

```bash
bash scripts/bootstrap-workspace.sh
```

After bootstrap, use the Milestone 1 runbook for the root command map that starts services, waits for readiness, runs migrations, workers, demos, reconciliation, projection rebuilds, and verification: [`docs/development/milestone-1-runbook.md`](milestone-1-runbook.md).

It is designed to be idempotent. A second run should validate or synchronize the same environment rather than create a parallel toolchain.

## GitHub Codespaces

The devcontainer pins Node 22 and Python 3.12 and supplies Docker-in-Docker, GitHub CLI, and SSH support. Codespaces invokes:

```bash
bash .devcontainer/post-create.sh
```

The post-create wrapper delegates to `scripts/bootstrap-workspace.sh`, so Codespaces and Codex Cloud use the same pnpm, uv, and dependency installation logic.

To re-run setup after changing a lockfile or environment script:

```bash
bash scripts/bootstrap-workspace.sh
```

To rebuild the complete container, use **Codespaces: Rebuild Container** from the command palette or rebuild it from the GitHub Codespaces UI.

## Codex Cloud

Create a Codex environment for `laurajoyhutchins/factory-floor` with Node 22 and Python 3.12.

Set its setup command to:

```bash
bash scripts/codex-cloud-setup.sh
```

Set its maintenance command to:

```bash
bash scripts/codex-cloud-maintenance.sh
```

The setup and maintenance wrappers install the Docker CLI and Compose plugin from Docker's official Ubuntu apt repository before synchronizing workspace dependencies. They intentionally do **not** install Docker Engine or assume that a daemon is available.

Codex runs setup scripts with internet access and may resume a cached environment using the maintenance script. Keep both environment settings pointed at these repository entrypoints rather than copying their contents into the Codex UI.

### Docker capability levels

The repository distinguishes three capabilities:

1. **Docker CLI available** — `docker --version` succeeds.
2. **Compose plugin available** — `docker compose version` and `docker compose config` succeed.
3. **Docker daemon reachable** — `docker info` succeeds and containers can be started.

`scripts/install-docker-cli.sh` provisions the first two capabilities on the Ubuntu-based Codex universal image. It reports daemon reachability but does not treat an unavailable daemon as an installation failure.

Verify the environment with:

```bash
docker --version
docker compose version
docker compose config
docker info
```

A successful `docker compose config` validates the development service definition. PostgreSQL and MinIO runtime health may only be claimed after `docker compose up` succeeds and the services report healthy. If Codex Cloud has no daemon, perform runtime service verification in Codespaces.

## Routine maintenance

The generic maintenance entrypoint is:

```bash
bash scripts/maintain-workspace.sh [command ...]
```

With no command, it runs `doctor`, which is non-destructive. It validates the pinned toolchain, reports Git status and disk usage, checks lockfile presence, runs `git diff --check`, and reports Docker availability.

Supported commands are:

| Command         | Behavior                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `doctor`        | Inspect toolchain, repository, storage, lockfiles, and Docker.                                      |
| `sync`          | Re-run the shared bootstrap and synchronize dependencies.                                           |
| `verify`        | Run available lint, typecheck, unit, Python, and Compose configuration checks.                      |
| `integration`   | Run the root `test:integration` script when defined.                                                |
| `clean`         | Remove transient build and test caches while preserving installed dependencies.                     |
| `reset`         | Remove `node_modules`, Python virtual environments, and the local pnpm store, then bootstrap again. |
| `pull-services` | Pull Docker Compose images when a Compose file exists and a daemon is reachable.                    |
| `all`           | Run `sync` followed by `verify`.                                                                    |

Commands may be combined and are executed from left to right:

```bash
bash scripts/maintain-workspace.sh clean sync verify
```

Recommended uses:

```bash
# Quick health inspection
bash scripts/maintain-workspace.sh doctor

# After pulling a branch with manifest or lockfile changes
bash scripts/maintain-workspace.sh all

# When generated output or test caches appear stale
bash scripts/maintain-workspace.sh clean verify

# When dependency installations are suspected to be corrupt
bash scripts/maintain-workspace.sh reset verify
```

`clean` and `reset` are never run implicitly. The script does not delete `.env`, runtime data, committed artifacts, Git state, or Docker volumes. Integration tests remain separate because they may require running PostgreSQL and MinIO services.

## Local or persistent SSH host

Install Node 22 and Python 3.12 through the host's normal version manager, clone the repository, and run:

```bash
git clone git@github.com:laurajoyhutchins/factory-floor.git
cd factory-floor
bash scripts/bootstrap-workspace.sh
```

Docker and GitHub CLI are optional for the shared bootstrap, but a reachable Docker daemon is required for the planned PostgreSQL and MinIO integration environment.

## Dependency reproducibility

Once a lockfile exists, bootstrap uses frozen installation:

```text
pnpm-lock.yaml  → pnpm install --frozen-lockfile
uv.lock         → uv sync through the applicable project
```

Before a lockfile exists, bootstrap allows the initial dependency resolution needed by Task 1. The resulting lockfiles must be committed so later environments reproduce the same dependency graph.

## Supported overrides

The defaults can be overridden for controlled experiments:

```bash
FACTORY_FLOOR_NODE_MAJOR=22 \
FACTORY_FLOOR_PYTHON_VERSION=3.12 \
FACTORY_FLOOR_PNPM_VERSION=10.12.1 \
  bash scripts/bootstrap-workspace.sh
```

The maintenance script reads the same overrides. A permanent version change requires corresponding updates to the specification, devcontainer, documentation, and lockfiles.

## Troubleshooting

- **Wrong Node or Python version:** change the base image or host version manager; the bootstrap intentionally fails rather than silently using an unsupported runtime.
- **`uv` or `pnpm` is not found in a later shell:** open a new shell or source `$HOME/.bashrc`; bootstrap persists `$HOME/.local/bin` in both `.bashrc` and `.profile`.
- **Frozen pnpm install fails:** the manifest and lockfile disagree. Update them together in the same reviewed change.
- **Docker CLI installation cannot reach `download.docker.com`:** allow that domain during setup or maintenance, then reset the Codex environment cache.
- **`docker compose config` works but `docker info` fails:** the client is installed but no daemon is available. Run container-dependent verification in Codespaces.
- **`doctor` reports uncommitted changes:** inspect them before running `reset`; maintenance never modifies Git state.
