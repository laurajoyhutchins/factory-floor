# Factory Floor Python Worker SDK

Async Python 3.12 SDK for the frozen `/worker/v1` protocol.

## Install and test

```bash
uv sync --project packages/worker-sdk-py --locked
uv run --project packages/worker-sdk-py --locked pytest
```

Configure `WorkerClientConfig(base_url="http://127.0.0.1:3000", bearer_token="placeholder", worker_id="demo-py")`. Credentials, lease tokens, capability handles, upload handles, and signed URLs are redacted by SDK errors.

## Component and runner

Implement `async run(envelope, context) -> ProposedResult`, register it as `{"verify@1": component}`, and start `WorkerRunner(client, components, concurrency=1).run_forever(["verify@1"])`. The runner polls, heartbeats before half the envelope heartbeat interval, signals cancellation through `context.cancellation`, stops claiming on graceful shutdown, and cancels/awaits heartbeat tasks.

## Artifacts and capabilities

Use `stage_json` or `stage_bytes` to compute SHA-256/size metadata, create a staging authorization, and stream upload content. Capability calls are explicit and are not replayed unless the caller opts into documented retry-safe semantics.

## Demo verifier

`workers/demo-py` provides `DetermininisticVerifier`/`verify`. When component configuration contains `failFirstAttemptForDemo: true`, attempt number `1` returns the canonical intentional failed proposed result. Attempts `2+` run normal deterministic verification. The decision is derived only from immutable `invocation.attemptNumber`, so worker restarts do not affect behavior.
