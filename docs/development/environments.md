# Reproducible Development Environments

Factory Floor uses one shared bootstrap path for Codespaces, Codex Cloud, and ordinary Linux development hosts.

## Environment contract

The base environment must provide:

- Bash, Git, and curl;
- Node.js 22 with Corepack;
- Python 3.12.

The repository bootstrap then:

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

Create a Codex environment for `laurajoyhutchins/factory-floor` with a base image or runtime configuration that provides Node 22 and Python 3.12.

Set its setup command to:

```bash
bash scripts/codex-cloud-setup.sh
```

The wrapper sets noninteractive CI behavior and delegates to the shared bootstrap. The initial setup needs network access to obtain pnpm, uv, and repository dependencies that are not already cached. Agent-time internet access can remain governed separately by the task environment.

Do not paste a second copy of the setup logic into the Codex environment UI. Keep the UI command as the single repository entrypoint above, so changes remain versioned and reviewable in Git.

## Routine maintenance

The maintenance entrypoint is:

```bash
bash scripts/maintain-workspace.sh [command ...]
```

With no command, it runs `doctor`, which is non-destructive. It validates the pinned toolchain, reports Git status and disk usage, checks lockfile presence, runs `git diff --check`, and reports Docker availability.

Supported commands are:

| Command | Behavior |
|---|---|
| `doctor` | Inspect toolchain, repository, storage, lockfiles, and Docker. |
| `sync` | Re-run the shared bootstrap and synchronize dependencies. |
| `verify` | Run available lint, typecheck, unit, Python, and Compose configuration checks. |
| `integration` | Run the root `test:integration` script when defined. |
| `clean` | Remove transient build and test caches while preserving installed dependencies. |
| `reset` | Remove `node_modules`, Python virtual environments, and the local pnpm store, then bootstrap again. |
| `pull-services` | Pull Docker Compose images when a Compose file exists. |
| `all` | Run `sync` followed by `verify`. |

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

Docker and GitHub CLI are optional for the shared bootstrap, but Docker is required for the planned PostgreSQL and MinIO integration environment.

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

The maintenance script reads the same overrides.

Changing these values does not change the approved architecture. A permanent version change requires corresponding updates to the specification, devcontainer, documentation, and lockfiles.

## Troubleshooting

- **Wrong Node or Python version:** change the base image or host version manager; the bootstrap intentionally fails rather than silently using an unsupported runtime.
- **`uv` or `pnpm` is not found in a later shell:** open a new shell or source `$HOME/.bashrc`; bootstrap persists `$HOME/.local/bin` in both `.bashrc` and `.profile`.
- **Frozen pnpm install fails:** the manifest and lockfile disagree. Update them together in the same reviewed change.
- **`doctor` reports uncommitted changes:** inspect them before running `reset`; maintenance never modifies Git state.
- **Docker is unavailable in Codex Cloud:** complete unit-level work there and run Docker-dependent integration checks in Codespaces unless the selected cloud environment explicitly supports Docker.
