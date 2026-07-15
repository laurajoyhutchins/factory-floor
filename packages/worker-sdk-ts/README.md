# TypeScript worker SDK

`@factory-floor/worker-sdk-ts` is a small HTTP client and runner for the frozen `/worker/v1` protocol. It imports generated protocol contracts from `@factory-floor/contracts-ts` and has no dependency on PostgreSQL, Fastify, Kysely, or control-plane internals.

## Configure a client

```ts
const client = new WorkerProtocolClient({
  baseUrl: process.env.FACTORY_FLOOR_WORKER_BASE_URL!,
  bearerToken: process.env.FACTORY_FLOOR_WORKER_TOKEN!,
  workerId: process.env.FACTORY_FLOOR_WORKER_ID ?? 'worker-1',
  requestTimeoutMs: 10_000,
});
```

The client sends `Authorization: Bearer <token>` and propagates tracing headers supplied to operations. SDK errors are `WorkerSdkError` instances with stable `kind`, `code`, `status`, and `retryable` fields. Error messages redact bearer credentials, lease tokens, capability handles, upload handles, and signed upload URLs.

## Define and register a component

```ts
const component: WorkerComponent = async (ctx) => {
  const artifact = await ctx.stageJson('output', { ok: true });
  return {
    status: 'completed',
    stagedArtifacts: [artifact],
    proposedEvents: [],
    externalActionProposals: [],
    resourceUsage: emptyResourceUsage(),
  };
};

const registry = new ComponentRegistry();
registry.register('example', '1', component);
```

Components receive the immutable invocation envelope, an abort signal, artifact helpers, capability helpers, and structured logging context. Components never receive database handles or committed artifact locators.

## Start a runner

```ts
const runner = new WorkerRunner({ client, registry, concurrency: 1 });
runner.installSignalHandlers();
await runner.run();
```

The runner polls for work, starts heartbeats, executes the matching component, observes cancellation before submitting, and submits only canonical proposed results. It stops claiming new work on graceful shutdown and waits for active work to complete or abort. Heartbeat timing is recalculated from the latest lease expiration. Cancellation or lease loss aborts the component and fences normal success submission.

## Retry behavior

Claim polling, heartbeat, cancellation observation, staged upload retries, and identical result submission use bounded retry only where the protocol defines repetition as safe. Capability invocation is not replayed unless the caller explicitly opts into retry for an idempotent operation.
