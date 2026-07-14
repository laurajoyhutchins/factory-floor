# Factory Floor Reference Implementation Specification v0.1

**Status:** Approved design baseline  
**Date:** 2026-07-14  
**Product:** Factory Floor  
**Architecture:** Composable Agent Runtime  
**Deployment profile:** Transactional modular monolith

## 1. Purpose

Factory Floor is a durable execution substrate for composing information-work systems from small processing, coordination, storage, policy, and lifecycle primitives. This reference implementation proves the runtime semantics before distributed coordination, learned scheduling, or visual construction are introduced.

The product-facing vocabulary may use factory language, while APIs and durable records retain precise runtime terms:

| Product language | Runtime term |
|---|---|
| Machine | Component definition or instance |
| Work cell | Region |
| Line | Connection |
| Workpiece | Artifact reference |
| Blueprint | Template |
| Factory Floor | Installation and operator console |

Product terminology must never obscure security, provenance, lifecycle, or schema semantics.

## 2. Version 0.1 goals

Version 0.1 must:

1. execute static reactive graphs durably;
2. support TypeScript and Python workers through one protocol;
3. preserve immutable artifacts and complete provenance;
4. distinguish commands, events, deliveries, executions, and attempts;
5. commit successful execution results atomically;
6. enforce capabilities and deterministic policies outside worker code;
7. preserve partial progress through downstream failure;
8. recover safely after control-plane or worker restart;
9. expose enough information for a live operator console and forensic trace;
10. establish the contracts later used for bounded dynamic child regions.

Dynamic child-region construction is a later milestone. Milestone 1 uses the statically declared investigation region in `examples/investigation-system.yaml`.

## 3. Non-goals

Version 0.1 does not include multi-cluster scheduling, Kafka, Temporal, Kubernetes operators, autonomous modification of the stable outer graph, indefinitely detached child regions, arbitrary visual workflow construction, learned scheduling, opaque shared memory, cross-organization delegation, GraphQL, or exactly-once execution claims.

## 4. Fixed technology choices

### Repository and build

- pnpm workspaces monorepo;
- Node.js 22 within major version 22;
- TypeScript 5.7 or later within major version 5;
- Python 3.12 managed with uv;
- root package scripts for orchestration; no monorepo framework initially.

### Control plane

- Fastify HTTP APIs;
- PostgreSQL 16 or later as the authoritative coordination and metadata store;
- Kysely with `pg` for typed SQL and migrations;
- Ajv 8 for JSON Schema validation;
- Pino structured logs;
- OpenTelemetry traces and metrics.

### Contracts and artifacts

- JSON Schema Draft 2020-12 is authoritative;
- schemas live under `contracts/schemas/`;
- generated TypeScript contracts live under `packages/contracts-ts/`;
- generated Python Pydantic contracts live under `packages/contracts-py/`;
- generated outputs are committed;
- artifact bytes use an `ArtifactBlobStore` interface;
- development supports local filesystem storage;
- production-compatible storage is S3-compatible;
- PostgreSQL stores artifact identity, digest, schema, provenance, state, and locator.

### Frontend

- React 19 with Vite;
- TanStack Query for server state;
- Server-Sent Events for live updates;
- React Flow may render topology but is not the durable graph model;
- the first UI is a read-mostly operator console, not a builder.

## 5. Process architecture

The control plane is one deployable with explicit internal modules sharing a PostgreSQL transaction boundary. TypeScript and Python workers are separately supervised processes using a versioned HTTP protocol.

```text
Control API / SSE
       │
       ▼
┌─────────────────────────────────────────┐
│ Factory Floor Control Plane             │
│ registration  topology  regions         │
│ scheduler     delivery  execution       │
│ policy        capability external action│
│ artifacts     projections observability │
└─────────────────────────────────────────┘
       │                         │
       ▼                         ▼
 PostgreSQL              Artifact Blob Store
       │
       ▼
 TypeScript and Python workers
```

Internal modules communicate through service interfaces and durable records. An in-process event bus is never treated as runtime truth.

## 6. Trust boundaries

Trusted enforcement code includes the lifecycle kernel, scheduler, delivery manager, transactional commit service, artifact metadata service, policy engine, capability service, external-action adapters, and migrations.

Treat worker output, model output, dynamic topology requests, artifact content, external responses, human-provided artifacts, and unbundled templates as untrusted input.

Workers cannot directly write authoritative tables, mint capabilities, publish authoritative events, finalize artifacts, or perform privileged external actions. Workers receive no PostgreSQL credentials.

## 7. Identity and semantic distinctions

Use UUIDv7 identifiers generated by the control plane. IDs are opaque at protocol boundaries and remain valid after termination.

A **command** requests a transition or execution. An **event** is an immutable statement that something occurred. A **delivery** routes one accepted command or event to one input. An **execution** is the logical computation for a trigger and input set. An **attempt** is one physical try; retry creates another attempt under the same execution unless policy explicitly redirects.

```text
Command or Event
  └─ Delivery
      └─ Execution
          ├─ Attempt 1
          ├─ Attempt 2
          └─ Attempt 3
```

These identities and lifecycles must not be collapsed into a generic “run.”

## 8. Durable data model

The initial database includes append-only definitions and schemas; regions and immutable topology revisions; commands, events, and deliveries; executions and attempts; artifact metadata, derivations, and staging; capabilities and grants; policy decisions and approvals; external-action state; resource-ledger entries; and projection checkpoints.

Normative table groups include:

- `artifact_schemas`, `component_definitions`, `port_definitions`, `templates`, `policies`;
- `regions`, `topology_revisions`, `component_instances`, `connections`;
- `commands`, `events`, `deliveries`;
- `executions`, `execution_attempts`, `execution_inputs`, `execution_outputs`;
- `artifacts`, `artifact_derivations`, `artifact_staging`;
- `capabilities`, `capability_grants`, `policy_decisions`, `approvals`;
- `external_actions`, `external_action_attempts`, `resource_ledger`, `projection_checkpoints`.

Definitions are append-only. Retirement prevents new use but never invalidates history. A component instance belongs to exactly one region. Exactly one of a delivery’s source command or source event is populated. `(execution_id, attempt_number)` is unique.

Artifact states are `staged`, `committed`, and `tombstoned`. Content is never modified in place.

## 9. Worker protocol

Workers claim attempts through authenticated worker-only endpoints and receive immutable invocation envelopes containing protocol version, execution and attempt IDs, lease token and expiration, lifecycle epoch, component identity and configuration, input artifact descriptors with short-lived read URLs, state reference, capability handles, cancellation and heartbeat URLs, and tracing context.

Workers submit proposed results containing:

```ts
interface ProposedExecutionResult {
  protocolVersion: "1.0";
  executionId: string;
  attemptId: string;
  leaseToken: string;
  lifecycleEpoch: number;
  status: "completed" | "failed" | "cancelled";
  stagedArtifacts: StagedArtifactRef[];
  proposedEvents: ProposedEvent[];
  proposedState?: StagedArtifactRef;
  externalActionProposals: ExternalActionProposal[];
  resourceUsage: ResourceUsage;
  failure?: FailureDescriptor;
}
```

The control plane rejects stale lease tokens, stale lifecycle epochs, undeclared ports, invalid schemas, unauthorized actions, or results for inactive attempts.

## 10. Transactional execution commit

Artifact bytes may be staged before commit. Runtime truth becomes visible through one PostgreSQL transaction.

For a successful attempt, the transaction must lock and validate the execution, attempt, delivery, region, and component instance; verify lease and lifecycle epoch; validate artifact digests, metadata, schemas, ports, and authority; insert committed artifact metadata and derivations; insert execution outputs; append validated events; create downstream deliveries; append state and resource-ledger records; record external-action proposals without dispatching them; mark attempt, execution, and delivery completed; and advance or enqueue projection work.

After transaction commit, staged blobs are promoted to committed locators idempotently. Promotion failure is reconciled; it never causes metadata to be silently rewritten.

A failed attempt records its failure artifact, resource usage, status, and retry decision without deleting staged partial artifacts. Retry creates a new attempt.

## 11. Delivery, leases, retries, and dead letters

Delivery is at-least-once. Ready work is claimed with row locking and `SKIP LOCKED`. A lease has owner, opaque token, and expiration. Workers heartbeat before half the lease interval. Expired active attempts are marked abandoned before work is reclaimed. Completion submissions are idempotent by attempt and lease token.

Development defaults:

- delivery lease: 60 seconds;
- heartbeat: 20 seconds;
- scheduler polling: 250 milliseconds;
- maximum attempt duration: component limit or 15 minutes;
- maximum attempts: 3;
- retry backoff: 1 second, 5 seconds, 30 seconds;
- all attempts count against budget.

Invalid input, schema mismatch, capability denial, and policy denial are not retried by default. Timeout, dependency, model, and unknown failures are retryable. Terminal unresolved delivery becomes `dead_lettered`; no work is silently deleted.

## 12. Region lifecycle and cancellation fencing

Region lifecycle includes declared, starting, ready, running, completing, completed, blocked, suspended, cancelling, cancelled, and failed states. Each region has a monotonically increasing `lifecycle_epoch`.

Cancellation increments the epoch, records the transition, propagates to descendants, stops new dispatch for the old epoch, signals active workers, permits bounded checkpointing, preserves late results diagnostically, rejects stale normal commits, and rechecks the epoch before external action dispatch.

## 13. Topology and regions

Topology is immutable and versioned per region. Every accepted graph change creates a complete effective local revision, not merely a patch. Executions retain the revision that dispatched them.

A topology request is schema validated, checked against allowed component definitions and bounds, checked against inherited policy and capabilities, assigned a deterministic diff, accepted or denied durably, and activated only for future dispatches.

Dynamic regions cannot modify ancestor topology. Stable outer topology changes require administrative deployment rather than an ordinary runtime command.

## 14. Policies, capabilities, and supervision

Policy outcomes are `deny`, `require-approval`, `modify`, and `allow`, with precedence in that order. Modifications may only narrow authority or resources. Non-comparable conflicts deny. Every decision records policy identity and version, evaluator version, normalized inputs, referenced artifacts, outcome, reason, and modifications.

Capabilities are opaque database-backed grants. Authorization verifies grant validity, expiration, grantee, normalized scope, usage limits, lifecycle epoch, and policy outcome. Delegation must be a strict normalized subset of the parent grant.

Each region has a deterministic supervisory kernel. An optional agentic supervisor may propose commands, but only the kernel applies lifecycle, retry, replacement, cancellation, completion, child-limit, and failure-propagation rules.

## 15. External actions

External writes are durable reconciled protocols:

```text
proposed → policy_checked → awaiting_approval → authorized
         → dispatching → acknowledged → reconciled
```

Terminal states include denied, failed, cancelled, and indeterminate. Every action has an idempotency key and a persisted outbound request artifact. After restart, dispatching or indeterminate actions are reconciled before retry. Irreversible and high-risk actions require explicit approval by default.

## 16. Public APIs and CLI

All HTTP endpoints are under `/api/v1`. Initial groups include immutable registration; system and topology application; command submission and cancellation; region, event, execution, trace, artifact, lineage, and approval inspection; worker claim, heartbeat, cancellation, staging, result, and capability invocation; and an SSE stream with resumable cursors.

The initial CLI is `ff` and supports development startup, schema and component registration, system application, command submission, region and trace inspection, artifact inspection and lineage, cancellation, and approval decisions. Human-readable output is the default; `--json` is supported.

## 17. Development deployment and recovery

Docker Compose provides PostgreSQL, MinIO, the control plane, TypeScript worker, Python worker, and optional console. Development may select the filesystem blob adapter. Environment configuration is validated at startup; only `.env.example` is committed.

On startup the control plane verifies migrations, abandons expired attempts, makes retryable work available, resumes projection checkpoints, reconciles staged and promoted blobs, reconciles uncertain external actions, resumes cancellation, and emits a durable recovery summary.

Historical replay rebuilds projections without dispatching workers or external actions. Execution replay creates a new isolated region execution and requires authority for external effects.

## 18. Observability and security

Logs include applicable installation, region, correlation, event, delivery, execution, attempt, and component IDs. Metrics cover queue state, execution and attempt status, lease expiry, latency, artifact bytes, policy outcomes, capabilities, resource usage, region lifecycle, and projection lag.

Security requirements include separate worker and operator credentials, worker-only protocol access, no database credentials in workers, short-lived artifact and capability handles, bounded inputs, validation before interpretation, allowlisted HTTP adapters with DNS and redirect protections, process resource limits, no configuration from untrusted artifacts, separate administrative topology authority, and append-only audit behavior.

Operational explanations derive from durable routing, policy, capability, execution, and artifact records. Private model reasoning is never required.

## 19. Conformance invariants

A conforming implementation preserves all of the following:

1. every component instance belongs to exactly one region;
2. every event has an attributable source and region;
3. every artifact is immutable;
4. every committed artifact has schema identity and provenance;
5. every external action requires a valid capability grant;
6. delegated authority cannot exceed parent authority;
7. dynamic regions cannot modify ancestor topology;
8. cancellation propagates and stale epochs cannot commit normal outputs;
9. policy decisions are durable;
10. failed attempts remain visible after retry;
11. resource consumption is attributable to attempt, execution, and region;
12. no delivery is silently discarded;
13. historical replay never repeats external side effects;
14. enforcement does not depend on worker compliance;
15. dynamic construction is explicitly bounded;
16. workers cannot publish runtime truth directly;
17. a successful result becomes visible atomically;
18. duplicate delivery or completion cannot duplicate committed outputs.

## 20. Acceptance scenario

Milestone 1 must automatically register schemas and components, apply the static investigation declaration, submit one command, fan out three retrieval executions, preserve their artifacts, deliberately fail the first verification attempt, run a replacement attempt, synthesize final outputs, complete according to the output contract, expose full causation and lineage, restart during another run without duplicate committed outputs, and cancel another run without stale outputs committing.

The full v0.1 target then replaces the static investigation region with bounded parent-authorized dynamic child-region construction and verifies historical replay without repeating external actions.
