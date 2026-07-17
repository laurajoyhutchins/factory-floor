# Factory Floor runtime contract reference v0.1

**Type:** Reference
**Status:** Approved and current for the v0.1 release baseline
**Authority:** JSON Schema Draft 2020-12 remains the language-neutral contract authority.

This page contains stable facts for implementers and integrators. Architecture rationale belongs in the [architecture explanation](../explanation/architecture.md); decision rationale belongs in the [architecture decisions](../explanation/architecture-decisions.md).

## Scope

The v0.1 runtime executes static reactive graphs durably, supports TypeScript and Python workers through one protocol, preserves immutable artifacts and provenance, distinguishes commands/events/deliveries/executions/attempts, commits successful results atomically, enforces policies and capabilities outside worker code, recovers after restart, and exposes inspection data for operators.

The release does not include Kafka, Temporal, Kubernetes operators, multi-cluster scheduling, GraphQL, arbitrary visual graph authoring, autonomous modification of the stable outer graph, indefinitely detached child regions, learned scheduling, opaque shared memory, cross-organization delegation, or exactly-once execution claims. Dynamic child-region construction is a later milestone; Milestone 1 uses the static investigation region in `examples/investigation-system.yaml`.

## Fixed stack

| Area          | Contract                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| Runtime       | Node.js 22, TypeScript 5.x, Python 3.12, pnpm, and uv                                                     |
| Control plane | Fastify, PostgreSQL 16+, Kysely, `pg`, Ajv 8, Pino, OpenTelemetry                                         |
| Contracts     | JSON Schema Draft 2020-12 under `contracts/schemas/`; generated TypeScript and Python types are committed |
| Artifacts     | `ArtifactBlobStore` with filesystem development support and S3-compatible production support              |
| Console       | React, Vite, TanStack Query, and SSE; read-mostly operator inspection rather than a builder               |

## Product and runtime vocabulary

| Product label | Runtime term                      |
| ------------- | --------------------------------- |
| Machine       | Component definition or instance  |
| Work cell     | Region                            |
| Line          | Connection                        |
| Workpiece     | Artifact reference                |
| Blueprint     | Template                          |
| Factory Floor | Installation and operator console |

Runtime terms remain precise in APIs, durable records, logs, and this reference.

## Durable identities

The control plane generates opaque UUIDv7 identifiers. A command requests a transition or execution. An event is an immutable statement. A delivery routes one accepted command or event to one input. An execution is the logical computation for one trigger and complete input set. An attempt is one physical try; retry creates another attempt under the same execution.

The initial database includes append-only definitions and schemas; regions and immutable topology revisions; commands, events, deliveries; executions and attempts; artifact metadata, derivations, and staging; capabilities and grants; policy decisions and approvals; external-action state; resource-ledger entries; and projection checkpoints.

Normative table groups include `artifact_schemas`, `component_definitions`, `port_definitions`, `templates`, `policies`; `regions`, `topology_revisions`, `component_instances`, `connections`; `commands`, `events`, `deliveries`; `executions`, `execution_attempts`, `execution_inputs`, `execution_outputs`; `artifacts`, `artifact_derivations`, `artifact_staging`; `capabilities`, `capability_grants`, `policy_decisions`, `approvals`; `external_actions`, `external_action_attempts`, `resource_ledger`, and `projection_checkpoints`.

Definitions are append-only. Retirement prevents new use without invalidating history. A component instance belongs to exactly one region. Exactly one of a delivery's source command or source event is populated. `(execution_id, attempt_number)` is unique.

Artifact states are `staged`, `committed`, and `tombstoned`. Content is never modified in place.

## Worker result contract

Workers claim attempts through authenticated worker-only endpoints and receive immutable invocation envelopes. A proposed result has this shape:

```ts
interface ProposedExecutionResult {
  protocolVersion: '1.0';
  executionId: string;
  attemptId: string;
  leaseToken: string;
  lifecycleEpoch: number;
  status: 'completed' | 'failed' | 'cancelled';
  stagedArtifacts: StagedArtifactRef[];
  proposedEvents: ProposedEvent[];
  proposedState?: StagedArtifactRef;
  externalActionProposals: ExternalActionProposal[];
  resourceUsage: ResourceUsage;
  failure?: FailureDescriptor;
}
```

The control plane rejects stale lease tokens, stale lifecycle epochs, undeclared ports, invalid schemas, unauthorized actions, and results for inactive attempts. See the [worker protocol reference](worker-protocol-v1.md) for endpoint behavior.

## Atomic commit and artifact rules

Artifact bytes may be staged before commit. For a successful attempt, one PostgreSQL transaction locks and validates the execution, attempt, delivery, region, and component instance; verifies lease and lifecycle epoch; validates digests, metadata, schemas, ports, and authority; inserts committed artifacts and derivations; inserts execution outputs; appends events; creates downstream deliveries; records resources and external-action proposals; marks attempt, execution, and delivery complete; and advances or enqueues projection work.

After commit, staged blobs are promoted to committed locators idempotently. Promotion failure is reconciled; metadata is not silently rewritten. Failed attempts retain failure artifacts, resource usage, status, retry decisions, and partial staged artifacts. Retries create new attempts.

## Delivery, leases, and retries

Delivery is at-least-once. Ready work is claimed with row locking and `SKIP LOCKED`. A lease has an owner, opaque token, and expiration. Expired active attempts are marked abandoned before work is reclaimed. Completion submissions are idempotent by attempt and lease token.

Local defaults are a 60-second delivery lease, 20-second heartbeat, 250-millisecond scheduler polling, a 15-minute maximum attempt duration unless a component limit is lower, three maximum attempts, and retry backoff of 1 second, 5 seconds, and 30 seconds. All attempts count against budget.

Invalid input, schema mismatch, capability denial, and policy denial are not retried by default. Timeout, dependency, model, and unknown failures are retryable. Terminal unresolved delivery becomes `dead_lettered`; no work is silently deleted.

## Lifecycle, topology, policy, and external actions

Regions have lifecycle states from declared through ready, running, completing, completed, blocked, suspended, cancelling, cancelled, and failed. Each region has a monotonically increasing `lifecycle_epoch`. Cancellation increments the epoch, propagates to descendants, stops old-epoch dispatch, signals workers, preserves late results diagnostically, rejects stale normal commits, and rechecks the epoch before external dispatch.

Topology is immutable and versioned per region. Every accepted graph change creates a complete effective local revision, and executions retain the revision that dispatched them. Dynamic regions cannot modify ancestor topology.

Policy outcomes are `deny`, `require-approval`, `modify`, and `allow`, with precedence in that order. Modifications may only narrow authority or resources. Capabilities are opaque database-backed grants; authorization verifies validity, expiration, grantee, normalized scope, usage limits, lifecycle epoch, and policy outcome.

External writes follow a durable reconciled state machine from proposal through policy, approval, authorization, dispatch, acknowledgement, and reconciliation. Every action has an idempotency key and persisted outbound request artifact. Indeterminate actions are reconciled after restart before retry.

## APIs, CLI, recovery, and security

HTTP endpoints are under `/api/v1` and include registration, system/topology application, command submission/cancellation, inspection, worker protocol, capability invocation, and resumable SSE. The `ff` CLI supports startup, registration, system application, command submission, inspection, artifact lineage, cancellation, and approval decisions; human-readable output is default and `--json` is supported.

On startup the control plane verifies migrations, abandons expired attempts, makes retryable work available, resumes projection checkpoints, reconciles staged and promoted blobs, reconciles uncertain external actions, resumes cancellation, and emits a durable recovery summary. Historical projection replay never dispatches workers or repeats external actions.

Worker and operator credentials are separate. Workers receive no database credentials. Artifact and capability handles are short-lived. Inputs are bounded and validated before interpretation. HTTP adapters are allowlisted and protect DNS and redirects. Logs include applicable durable identities without recording secrets.

## Conformance invariants

The implementation preserves the following 18 normative invariants:

1. Every component instance belongs to exactly one region.
2. Every event has an attributable source and region.
3. Every artifact is immutable.
4. Every committed artifact has schema identity and provenance.
5. Every external action requires a valid capability grant.
6. Delegated authority cannot exceed parent authority.
7. Dynamic regions cannot modify ancestor topology.
8. Cancellation propagates and stale epochs cannot commit normal outputs.
9. Policy decisions are durable.
10. Failed attempts remain visible after retry.
11. Resource consumption is attributable to attempt, execution, and region.
12. No delivery is silently discarded.
13. Historical replay never repeats external side effects.
14. Enforcement does not depend on worker compliance.
15. Dynamic construction is explicitly bounded.
16. Workers cannot publish runtime truth directly.
17. A successful result becomes visible atomically.
18. Duplicate delivery or completion cannot duplicate committed outputs.

The machine-readable [conformance ledger](conformance-ledger.yaml) records coverage and verification for the static Milestone 1 scope.
