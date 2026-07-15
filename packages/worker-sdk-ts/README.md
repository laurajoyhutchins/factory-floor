# TypeScript worker SDK

`@factory-floor/worker-sdk-ts` is a typed HTTP client and runner for the frozen `/worker/v1` protocol. It consumes generated contract types from `@factory-floor/contracts-ts` and has no dependency on PostgreSQL, Fastify, Kysely, or control-plane internals.

## Configure a client

```ts
const client = new WorkerProtocolClient({
  baseUrl: process.env.FACTORY_FLOOR_WORKER_BASE_URL!,
  bearerToken: process.env.FACTORY_FLOOR_WORKER_TOKEN!,
  workerId: process.env.FACTORY_FLOOR_WORKER_ID ?? 'worker-1',
  requestTimeoutMs: 10_000,
});
```

The client sends a separately configured worker bearer token, propagates trace headers, validates claimed invocation envelopes, and maps protocol failures to `WorkerSdkError` with stable `kind`, `code`, `status`, and `retryable` fields. Error messages redact credentials, lease tokens, capability handles, upload handles, and signed upload URLs.

## Define and register a component

```ts
const component: WorkerComponent = async (context) => {
  const artifact = await context.stageJson(
    'output',
    { ok: true },
    {
      schemaId: 'example-output.v1',
      schemaDigest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
  );
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

Components receive the immutable invocation envelope, an `AbortSignal`, artifact helpers, capability helpers, and structured logging context. They never receive database handles or committed artifact locators.

`stageJson` and `stageBinary` require the declared artifact schema identity and digest, calculate the content digest and size, obtain a staging authorization, upload immutable bytes, and return a generated `StagedArtifact` shape. Binary inputs are copied to owned bytes before fetch so Buffer and typed-array views preserve exact byte identity.

## Start a runner

```ts
const runner = new WorkerRunner({ client, registry, concurrency: 1 });
runner.installSignalHandlers();
await runner.run();
```

The runner advertises registered `name@version` selectors, honors server-provided no-work delays, heartbeats active attempts, observes durable cancellation before submission, and fences success after cancellation or heartbeat uncertainty. Component exceptions produce a sanitized retryable failed proposal instead of silently abandoning the attempt.

## Retry behavior

Claim, heartbeat, cancellation observation, and identical result submission use bounded retries only where the protocol defines repetition as safe. One-shot Node or web streams are never replayed after consumption. Capability invocation is not replayed unless the caller explicitly marks the operation retry-safe.
