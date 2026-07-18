# Inspect the runtime with the operator console

**Type:** How-to
**Status:** Current

The console is a read-only inspection surface. It has no database credentials and does not submit commands, retry work, approve actions, cancel runs, rebuild projections, or modify topology.

## Start locally

1. Copy `.env.example` to `.env` and set distinct local operator, admin, and worker tokens.
2. Bootstrap dependencies with `bash scripts/bootstrap-workspace.sh`.
3. Start PostgreSQL and MinIO with `pnpm services:up` and wait with `pnpm services:wait`.
4. Apply migrations with `pnpm db:migrate`.
5. Start the control plane with `pnpm dev:control-plane`.
6. Start the TypeScript and Python demo workers, or use `pnpm dev:workers`.
7. Run `pnpm demo:investigation`.
8. Start the console with `pnpm dev:console` and open the printed loopback URL.

The Vite server proxies `/health` and `/api/*` to `FACTORY_FLOOR_CONSOLE_CONTROL_PLANE_URL`, defaulting to `http://127.0.0.1:3000`. It sends `VITE_FACTORY_FLOOR_OPERATOR_TOKEN` only to read-only inspection routes.

## Available views

- **Overview:** health, projection checkpoint and staleness summaries, resource and progress cards, and recent events.
- **Topology:** active regions, component instances, ports, lifecycle state, and directed connections.
- **Executions:** pageable executions with command and event causation, deliveries, attempts, outputs, and downstream effects.
- **Artifacts:** pageable immutable artifact metadata and lineage relationships; arbitrary bytes are not fetched or rendered.
- **Operations:** deliveries, attempts, resource ledger, policy decisions, and projection checkpoints.

## Live updates

The console connects to `GET /api/v1/inspect/stream`, preserves the server cursor, deduplicates durable event IDs, bounds the visible buffer, and reconnects with backoff. A finite server batch is normal and is followed by a safe reconnect.

## Read-only guarantee

The browser client exposes only GET operations. Administrative operations such as projection rebuild remain separate authenticated control-plane endpoints and are not reachable through the console UI.

Opaque runtime JSON is rendered without rewriting its keys. Only control-plane-owned response envelope fields are adapted for the browser.

## Troubleshooting

- HTTP 401 means no operator or admin bearer token was supplied.
- HTTP 403 means the supplied token lacks the required scope.
- Disconnected health usually means the control plane is not listening at the proxy target.
- Empty pages are normal before the investigation demo has produced records.
- Interpret stale projections from checkpoint metadata; the console does not imply freshness when checkpoints are missing or old.
