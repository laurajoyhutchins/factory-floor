# Factory Floor Python Worker SDK

Async Python 3.12 SDK for the frozen `/worker/v1` protocol.

## Install and test

```bash
uv sync --project packages/worker-sdk-py --locked
uv run --project packages/worker-sdk-py --locked pytest
```

Create a client with explicit credentials and identity:

```python
from factory_floor_worker_sdk import WorkerClient, WorkerClientConfig

client = WorkerClient(
    WorkerClientConfig(
        base_url="http://127.0.0.1:3000",
        bearer_token="local-worker-token",
        worker_id="demo-py-worker",
    )
)
```

Credentials, lease tokens, capability handles, upload handles, and signed URLs are redacted from SDK exceptions.

## Components and runner

Implement `async run(envelope, context) -> ProposedResult`, register it by the exact component selector, and start the runner:

```python
runner = WorkerRunner(client, {"verify@1": verifier}, concurrency=1)
await runner.run_forever()
```

The runner derives claim capabilities from the registry, uses the endpoint references in each invocation envelope, heartbeats while work is active, observes durable cancellation before submission, fences submission after heartbeat or lease uncertainty, and submits a sanitized failed proposal when component execution raises.

Graceful shutdown stops new claims, allows active work a bounded completion period, then cancels and awaits remaining execution and heartbeat tasks.

## Artifacts and capabilities

`stage_json` and `stage_bytes` hash content in bounded chunks, request a durable staging authorization, stream the content, verify the returned digest and size, and return a generated `StagedArtifact` model. Callers provide the declared artifact schema identity and digest.

Capability calls are explicit through `context.invoke_capability(...)`. They are not replayed unless the caller marks the operation retry-safe.

## Demo verifier

`workers/demo-py` contains the deterministic `verify@1` component. When the immutable component configuration contains `failFirstAttemptForDemo: true`, invocation attempt `1` returns the canonical intentional failed proposal. Attempts `2+` stage `verified-claims` and complete normally. No process-local counter, file, cache, environment mutation, or external state controls the decision.
