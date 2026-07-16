# Read-only operator console

The first Factory Floor operator console is a desktop-first inspection surface. It consumes only supported control-plane `GET` inspection APIs through the browser and Vite development proxy; it has no database credentials and no runtime mutation controls.

## Start locally

1. Copy `.env.example` to `.env` and replace the local operator, admin, and worker tokens before exposing any port.
2. Bootstrap dependencies: `bash scripts/bootstrap-workspace.sh`.
3. Start PostgreSQL and MinIO: `pnpm dev:services`.
4. Apply migrations: `pnpm db:migrate`.
5. Start the control plane: `pnpm dev:control-plane`.
6. In separate shells, start demo workers with `pnpm dev:worker-demo-ts` and `pnpm dev:worker-demo-py` or the combined development process where appropriate.
7. Run the investigation demo: `pnpm demo:investigation`.
8. Start the console: `pnpm dev:console` and open the printed loopback URL.

The console dev server proxies `/health` and `/api/*` to `FACTORY_FLOOR_CONSOLE_CONTROL_PLANE_URL`, defaulting to `http://127.0.0.1:3000`. It sends `VITE_FACTORY_FLOOR_OPERATOR_TOKEN` only to read-only inspection routes. No CORS relaxation is required for ordinary local development.

The control plane binds to `127.0.0.1` by default and refuses to start without distinct `CONTROL_PLANE_OPERATOR_TOKEN` and `CONTROL_PLANE_ADMIN_TOKEN` values. Inspection `GET` requests accept either token; command submission, registration, system application, projection rebuild, and other administrative operations require the admin token.

## Views

- Overview: health, projection checkpoint/staleness summaries, resource/progress cards, and recent runtime events.
- Topology: active regions, component instances, ports, lifecycle state, and directed connections.
- Executions: pageable executions plus trace detail with command/event causation, deliveries, attempts, outputs, and downstream effects.
- Artifacts: pageable artifact metadata and lineage relationships; arbitrary artifact bytes are not fetched or rendered.
- Operations: deliveries, attempts, resource ledger, policy decisions, and projection checkpoints.

## Live stream

The shell connects to `GET /api/v1/inspect/stream`, sends the operator bearer token, preserves the opaque cursor supplied by the server, deduplicates durable event IDs, bounds the visible buffer, and backs off while the document is hidden. A finite server batch is treated as normal and followed by a safe reconnect.

## Read-only guarantee and limitations

The console API module exposes only GET operations and intentionally omits projection rebuild, command, registration, worker, retry, approval, cancellation, and topology mutation endpoints. Projection rebuild is an authenticated admin operation at `POST /api/v1/admin/projections/rebuild`. The console is not a workflow builder, cannot create dynamic regions, cannot mutate runtime state, and does not implement user accounts or interactive sign-in. Dynamic regions remain deferred to Milestone 2+ work.

Opaque runtime JSON such as payloads, provenance, component configuration, policy inputs, attributes, modifications, and failures is rendered without rewriting its keys. Only control-plane-owned response envelope fields are adapted from snake case to camel case.

## Troubleshooting

- HTTP 401 means no operator/admin bearer token was supplied; HTTP 403 means the supplied token lacks the required scope.
- Disconnected health usually means the control plane is not listening at the proxy target.
- Empty pages are normal before the investigation demo has produced records.
- Stale projections should be interpreted according to checkpoint metadata; the console does not imply freshness when checkpoints are missing or old.
- A direct route refresh works in Vite development/preview through client-side history fallback.
