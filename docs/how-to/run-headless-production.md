# Run Factory Floor headlessly

This guide describes the first supported non-interactive process boundary for the Factory Floor control plane and demo workers. It runs without the operator console, browser, watch mode, or an interactive terminal.

## Prerequisites

Bootstrap the pinned workspace and start the required services:

```bash
bash scripts/bootstrap-workspace.sh
pnpm services:up
pnpm services:wait
pnpm db:migrate
```

The production control plane refuses to listen when migrations are pending or the artifact store cannot be opened.

## Required environment

Copy `.env.example` to an untracked `.env` and replace every disposable value. Production startup requires:

- `DATABASE_URL`
- an absolute `ARTIFACT_STORE_ROOT`
- `HOST` and an optional valid `PORT`
- `FACTORY_FLOOR_CONTROL_PLANE_URL`
- distinct `CONTROL_PLANE_OPERATOR_TOKEN` and `CONTROL_PLANE_ADMIN_TOKEN`
- `WORKER_AUTHORIZATION_JSON`, or the supported single-worker authorization variables

Each worker requires:

- `FACTORY_FLOOR_WORKER_BASE_URL`
- `FACTORY_FLOOR_WORKER_TOKEN`
- `FACTORY_FLOOR_WORKER_ID`
- an optional positive `FACTORY_FLOOR_WORKER_CONCURRENCY`

Control-plane and worker URLs must use HTTP or HTTPS and must not embed credentials. Service-auth keys, when used, must be configured as complete current key pairs; previous rotation keys require current keys.

The `scripts/run-with-env.mjs` development wrapper resolves a relative local artifact path to an absolute path before starting a child process. Direct production startup does not reinterpret relative paths.

## Build production artifacts

Build the complete TypeScript project graph and the production-only control-plane entrypoint from a clean checkout:

```bash
pnpm build:production
```

The supported compiled entrypoints are:

- `apps/control-plane/dist/server.js`
- `workers/demo-ts/dist/index.js`
- the Python console script `factory-floor-demo-py`

## Start the processes

Start the control plane:

```bash
pnpm --filter @factory-floor/control-plane start
```

Start the TypeScript worker in another process:

```bash
pnpm --filter @factory-floor/demo-ts-worker start
```

Start the Python worker in another process:

```bash
uv run --project workers/demo-py --locked factory-floor-demo-py
```

Workers never receive PostgreSQL credentials. They communicate with the authoritative TypeScript control plane only through worker protocol v1.

## Health checks

Use liveness only to determine whether the control-plane process is serving HTTP:

```text
GET /health/live
```

Use readiness before sending work:

```text
GET /health/ready
```

Readiness checks the migration state and artifact store. It returns HTTP 503 with stable dependency names when either check fails. Raw dependency errors are logged but are not returned to the caller.

The legacy `GET /health` endpoint remains available as a compatibility liveness response.

## Shutdown behavior

Send SIGTERM or SIGINT to stop a process.

The control plane stops accepting new HTTP work through Fastify shutdown, waits for application close hooks, stops projection catch-up, and destroys its owned database pool exactly once.

The TypeScript production worker sets a local claim fence before stopping its runner. Calls made after shutdown begins receive local no-work responses rather than issuing new network claims. Already-leased executions continue to the SDK cancellation check before any result submission.

The Python runner stops its claim loop, waits for active executions for its bounded shutdown interval, cancels any remaining tasks, and checks cancellation or lease loss before submitting a result.

A stale or inactive attempt cannot commit after shutdown or restart; the control plane remains the only writer of durable lifecycle truth.

## Run the unattended acceptance

Run the canonical process-level acceptance:

```bash
pnpm acceptance:m1-live-restart
```

This command:

1. runs the canonical production build;
2. verifies the compiled control-plane and TypeScript worker artifacts exist;
3. launches the real compiled control plane and supported workers without a browser or TTY;
4. completes the investigation workflow;
5. terminates and restarts the control plane while a verifier attempt is leased;
6. proves the stale attempt is fenced;
7. verifies all executions complete without duplicate outputs or deliveries; and
8. writes process-mode evidence to `.factory-floor/verification/headless-production/summary.json`.

## Current operational boundary

This slice intentionally does not provide a host daemon, process supervisor, installer, Kubernetes manifests, remote log service, or hosted control plane. The acceptance harness owns child-process startup, signal forwarding, and prefixed log multiplexing. Filesystem artifact storage remains local to the control-plane host.

These limitations are evidence for later deployment decisions. A remote host daemon or different implementation language should be introduced only when an observed operational requirement cannot be met by this process boundary.
