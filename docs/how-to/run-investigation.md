# Run and inspect the investigation

**Type:** How-to
**Status:** Current for the v0.1 release baseline

Use this guide to run the static Milestone 1 investigation, inspect its durable trace, reconcile artifacts, and exercise the accepted recovery and cancellation checks.

## Start the services

Complete the [development environment setup](development-environment.md), then start the control plane and workers in separate terminals:

```bash
pnpm dev:control-plane
pnpm dev:worker-demo-ts
pnpm dev:worker-demo-py
```

For local orchestration, use `pnpm dev:workers` after PostgreSQL and MinIO are ready.

## Run the demo

```bash
pnpm demo:investigation
```

The static graph deliberately makes verifier attempt 1 fail, keeps its failed attempt and partial artifacts inspectable, retries safely, and completes without duplicate committed outputs.

## Inspect the durable records

```bash
pnpm --filter @factory-floor/cli exec ff inspect events --json
pnpm --filter @factory-floor/cli exec ff inspect deliveries --json
pnpm --filter @factory-floor/cli exec ff inspect executions --json
pnpm --filter @factory-floor/cli exec ff inspect attempts --json
pnpm --filter @factory-floor/cli exec ff inspect artifacts --json
pnpm --filter @factory-floor/cli exec ff inspect projections --json
```

Confirm that both verifier attempts remain visible, committed artifacts have valid digests, schemas, and provenance, resource entries are attributable, the trace reconstructs causation, and retry did not duplicate outputs.

## Reconcile artifacts and rebuild projections

```bash
pnpm artifacts:reconcile
pnpm projections:rebuild
```

Reconciliation repairs storage metadata relationships without rewriting immutable identity. Projection rebuild reads durable history only; it must not dispatch workers or repeat external actions.

## Run acceptance checks

The canonical clean-checkout acceptance command is:

```bash
pnpm accept:m1
```

The accepted run includes live control-plane restart, cancellation epoch fencing, recovery, projection replay, artifact reconciliation, policy evidence, and sanitized operator evidence. The [Milestone 1 acceptance reference](../reference/acceptance/m1-durable-reactive-graph.md) records the frozen verification result.

For focused checks:

```bash
pnpm acceptance:m1-live-restart
pnpm test:conformance
pnpm test:integration
```

## Stop services

```bash
pnpm services:down
```

Use `pnpm services:clean` only when you intentionally need to remove development service volumes.
