# Milestone 1 developer runbook

This runbook is the copyable command map for a clean Codespace checkout. Run commands from the repository root.

## Architecture boundaries

- The TypeScript control plane owns authoritative runtime state and commits commands, events, deliveries, executions, attempts, artifact metadata, resource ledger entries, lifecycle epochs, and projection checkpoints in PostgreSQL.
- TypeScript and Python workers are untrusted proposal processes. They claim attempts through `/worker/v1`, stage bytes, heartbeat leases, observe cancellation, and submit proposed results. They do not receive PostgreSQL credentials and cannot finalize artifacts.
- PostgreSQL is the coordination source of truth. MinIO or the filesystem stores immutable content-addressed bytes. Projections are derived and may be rebuilt from durable history without worker dispatch or external actions.

## Clean checkout setup

```bash
bash scripts/bootstrap-workspace.sh
cp .env.example .env
pnpm services:up
pnpm services:wait
pnpm db:migrate
```

Bootstrap uses Node 22, Corepack-managed `pnpm@10.12.1`, Python 3.12, and uv locked environments. Root development and maintenance commands load an optional repository-root `.env`; Docker Compose uses the same file automatically. If a frozen install fails, update the manifest and lockfile together in one reviewed change.

## Root command map

| Goal                                    | Command                    |
| --------------------------------------- | -------------------------- |
| Bootstrap dependencies                  | `pnpm bootstrap`           |
| Start PostgreSQL and MinIO              | `pnpm services:up`         |
| Wait for service readiness              | `pnpm services:wait`       |
| Show service status                     | `pnpm services:status`     |
| Show concise service logs               | `pnpm services:logs`       |
| Run migrations                          | `pnpm db:migrate`          |
| Reset database in development/test only | `pnpm db:reset`            |
| Start control plane                     | `pnpm dev:control-plane`   |
| Start TypeScript worker                 | `pnpm dev:worker-demo-ts`  |
| Start Python worker                     | `pnpm dev:worker-demo-py`  |
| Start control plane and both workers    | `pnpm dev:workers`         |
| Run investigation demo                  | `pnpm demo:investigation`  |
| Run TypeScript unit tests               | `pnpm test`                |
| Run Python tests                        | `pnpm test:python`         |
| Run integration tests                   | `pnpm test:integration`    |
| Run recovery/replay conformance tests   | `pnpm test:conformance`    |
| Full service-backed verification        | `pnpm verify`              |
| Contract validation                     | `pnpm contracts:validate`  |
| Generated contract drift check          | `pnpm contracts:check`     |
| Lint                                    | `pnpm lint`                |
| Typecheck                               | `pnpm typecheck`           |
| Format check                            | `pnpm format:check`        |
| Artifact reconciliation dry run         | `pnpm artifacts:reconcile` |
| Projection rebuild                      | `pnpm projections:rebuild` |
| Remove transient build/test caches      | `pnpm cleanup`             |
| Stop services                           | `pnpm services:down`       |
| Remove service volumes                  | `pnpm services:clean`      |

`pnpm verify` validates contracts, generated-code drift, formatting, lint, types, TypeScript and Python tests, Compose configuration, service readiness, migrations, the Docker-backed integration/demo path, and recovery/replay tests. It starts and stops PostgreSQL and MinIO while preserving volumes by default. Set `FACTORY_FLOOR_VERIFY_CLEAN=1` to remove existing volumes before the run.

Long-running combined development orchestration (`pnpm dev:workers`) starts each process in a dedicated process group, forwards termination signals to the complete child trees, escalates to `SIGKILL` after three seconds, and returns a non-zero exit code if any child exits unexpectedly.

## Investigation demo and inspection

1. Start services and migrate the database.
2. Start the control plane and both workers in separate terminals, or use `pnpm dev:workers` for local orchestration.
3. Run `pnpm demo:investigation`.
4. Inspect state:

```bash
pnpm --filter @factory-floor/cli exec ff inspect events --json
pnpm --filter @factory-floor/cli exec ff inspect deliveries --json
pnpm --filter @factory-floor/cli exec ff inspect executions --json
pnpm --filter @factory-floor/cli exec ff inspect attempts --json
pnpm --filter @factory-floor/cli exec ff inspect artifacts --json
pnpm --filter @factory-floor/cli exec ff inspect projections --json
```

The investigation graph deliberately makes verifier attempt 1 fail, keeps that failed attempt and partial artifacts inspectable, then retries safely. Treat the first verifier failure as expected only when a later attempt succeeds and duplicate outputs are absent.

## Artifact reconciliation and projection rebuild

Run reconciliation before claiming artifact health:

```bash
pnpm artifacts:reconcile
```

Rebuild projections through the control-plane inspection API:

```bash
pnpm projections:rebuild
```

Set `FACTORY_FLOOR_PROJECTION_BATCH_SIZE` to an integer from 1 through 10000 to change the rebuild batch size. Projection rebuild is derived from history only; it must not dispatch workers or perform external actions.

## Cancellation and restart checks

Cancellation acceptance requires evidence that lifecycle epoch fencing rejects stale normal commits while preserving diagnostic late results. Restart acceptance requires evidence that an actual control-plane process restart during an investigation abandons or resumes work without lost executions or duplicate committed outputs.

The current recovery/replay integration tests cover repeated recovery idempotency, cancellation settlement, stale-result fencing, and side-effect-free projection replay. They do not yet replace the still-open acceptance item for restarting the live control-plane process during the investigation demo, nor the broader requirement for conformance coverage of every reference-specification invariant. Keep those evidence rows explicitly incomplete until those scenarios exist and pass from a clean Codespace checkout.

## Security and ports

`.env.example` contains local-only credentials. Copy it to the ignored `.env` for personal overrides; never commit real credentials, worker tokens, signed URLs, or production endpoints.

Docker Compose binds PostgreSQL, MinIO API, and MinIO console to `127.0.0.1` by default. Override `FACTORY_FLOOR_POSTGRES_BIND`, `FACTORY_FLOOR_MINIO_BIND`, and port variables only on trusted development hosts. Codespaces may forward selected loopback ports for the current user, but database and object-storage ports should not be made public.

## Troubleshooting

- `pnpm install --frozen-lockfile` fails: manifest and lockfile drifted; regenerate only for the intentional manifest change.
- `uv sync --locked` fails: the Python project lock is stale; update that project lock with the manifest change.
- `pnpm services:wait` times out: run `pnpm services:status` and `pnpm services:logs`; the wait script requires healthy containers and live MinIO/PostgreSQL readiness rather than sleeping a fixed duration.
- Docker works in Codespaces/CI but not Codex Cloud: Codex Cloud may have Docker CLI and Compose without a reachable daemon. Use Codespaces or CI for service-backed verification.
- `pnpm db:reset` fails: it is intentionally restricted to development/test through `NODE_ENV=development` in the root command.
- Worker authentication fails: verify that `.env` defines the same local value for `WORKER_API_BEARER_TOKEN` and `FACTORY_FLOOR_WORKER_TOKEN` and that the worker base URL matches the control-plane URL.
