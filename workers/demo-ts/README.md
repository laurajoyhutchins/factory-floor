# Demo TypeScript worker

This package registers deterministic `retrieve@1`, `compare@1`, and `synthesize@1` components through the public TypeScript worker SDK registry. The Python worker branch owns verification.

The components avoid live web access, model calls, randomness, and wall-clock-dependent output. They canonicalize JSON ordering so repeated normalized inputs produce byte-identical artifacts.

## Environment

- `FACTORY_FLOOR_WORKER_BASE_URL` defaults to `http://localhost:3000`.
- `FACTORY_FLOOR_WORKER_TOKEN` must match the control plane worker token.
- `FACTORY_FLOOR_WORKER_ID` defaults to `demo-ts-worker`.
- `FACTORY_FLOOR_WORKER_CONCURRENCY` defaults to `1`.

## Run

```bash
pnpm --filter @factory-floor/demo-ts-worker start
```
