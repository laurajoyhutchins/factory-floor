# Demo TypeScript worker

This package registers deterministic `retrieve@1`, `compare@1`, and `synthesize@1` components through the public TypeScript worker SDK. The Python worker owns `verify@1`.

The components avoid live web access, model calls, randomness, and wall-clock-dependent output. They canonicalize input ordering so repeated normalized inputs produce byte-identical JSON artifacts.

Canonical ports:

- `retrieve@1` stages `evidence`.
- `compare@1` stages `candidate-claims`.
- `synthesize@1` stages all required terminal outputs: `result`, `evidence-bundle`, and `uncertainty-report`.

## Environment

- `FACTORY_FLOOR_WORKER_BASE_URL` defaults to `http://localhost:3000`.
- `FACTORY_FLOOR_WORKER_TOKEN` is required and must match the separately configured control-plane worker token.
- `FACTORY_FLOOR_WORKER_ID` defaults to `demo-ts-worker`.
- `FACTORY_FLOOR_WORKER_CONCURRENCY` defaults to `1`.

## Run

```bash
pnpm --filter @factory-floor/demo-ts-worker start
```
