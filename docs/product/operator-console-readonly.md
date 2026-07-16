# Read-only operator console

The first Factory Floor operator console is a desktop-first inspection surface. It consumes only supported control-plane `GET` inspection APIs through the browser and Vite development proxy; it has no database credentials and no runtime mutation controls.

## Start locally

1. Bootstrap dependencies: `bash scripts/bootstrap-workspace.sh`.
2. Start PostgreSQL and MinIO: `pnpm dev:services`.
3. Apply migrations: `pnpm db:migrate`.
4. Start the control plane: `pnpm dev:control-plane`.
5. In separate shells, start demo workers with `pnpm dev:worker-demo-ts` and `pnpm dev:worker-demo-py` or the combined development process where appropriate.
6. Run the investigation demo: `pnpm demo:investigation`.
7. Start the console: `pnpm dev:console` and open the printed loopback URL.

The console dev server proxies `/health` and `/api/*` to `FACTORY_FLOOR_CONSOLE_CONTROL_PLANE_URL`, defaulting to `http://127.0.0.1:3000`. No CORS relaxation is required for ordinary local development.

## Views

- Overview: health, projection checkpoint/staleness summaries, resource/progress cards, and recent runtime events.
- Topology: active regions, component instances, ports, lifecycle state, and directed connections.
- Executions: pageable executions plus trace detail with command/event causation, deliveries, attempts, outputs, and downstream effects.
- Artifacts: pageable artifact metadata and lineage relationships; arbitrary artifact bytes are not fetched or rendered.
- Operations: deliveries, attempts, resource ledger, policy decisions, and projection checkpoints.

## Live stream

The shell connects to `GET /api/v1/inspect/stream`, preserves the opaque cursor supplied by the server, deduplicates durable event IDs, bounds the visible buffer, and backs off while the document is hidden. A finite server batch is treated as normal and followed by a safe reconnect.

## Read-only guarantee and limitations

The console API module exposes only GET operations and intentionally omits projection rebuild, command, registration, worker, retry, approval, cancellation, and topology mutation endpoints. This is not a workflow builder, cannot create dynamic regions, cannot mutate runtime state, and does not implement authentication or multi-user permissions. Dynamic regions remain deferred to Milestone 2+ work.

## Troubleshooting

- Disconnected health usually means the control plane is not listening at the proxy target.
- Empty pages are normal before the investigation demo has produced records.
- Stale projections should be interpreted according to checkpoint metadata; the console does not imply freshness when checkpoints are missing or old.
- A direct route refresh works in Vite development/preview through client-side history fallback.
