# Factory Floor Python Demo Worker

This package provides the deterministic `verify@1` worker component for the Milestone 1 investigation flow.

## Run as a worker

```bash
uv sync --project workers/demo-py --locked
FACTORY_FLOOR_WORKER_TOKEN=local-worker-token-do-not-use-in-production \
uv run --project workers/demo-py --locked factory-floor-demo-py
```

Optional environment variables:

- `FACTORY_FLOOR_WORKER_BASE_URL`, default `http://127.0.0.1:3000`
- `FACTORY_FLOOR_WORKER_ID`, default `demo-py-worker`
- `FACTORY_FLOOR_WORKER_CONCURRENCY`, default `1`

The worker claims only `verify@1`, heartbeats and observes cancellation through the Python SDK, and stages successful output on the canonical `verified-claims` port.

## Deterministic first-attempt failure

When the invocation component configuration contains `failFirstAttemptForDemo: true`, attempt number `1` submits a retryable failure with code `DEMO_FIRST_ATTEMPT_INTENTIONAL_FAILURE`. Attempts `2+` complete normally. The choice depends only on immutable invocation data, so restarting the process does not change behavior or mutate prior attempt history.

## Inspect an envelope offline

Passing a JSON invocation-envelope file keeps the deterministic inspection mode:

```bash
uv run --project workers/demo-py --locked factory-floor-demo-py path/to/envelope.json
```
