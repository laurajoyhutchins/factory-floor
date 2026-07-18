# Factory Floor architecture

**Type:** Explanation
**Status:** Current for v0.1

Factory Floor is a durable execution substrate for information-work systems. It composes processing, coordination, storage, policy, and lifecycle primitives while keeping runtime truth explicit and inspectable.

## The central model

The control plane is one transactional modular monolith. It owns the durable state machine and shares a PostgreSQL transaction boundary across registration, topology, scheduling, delivery, execution, policy, artifact, external-action, projection, and observability modules.

Workers are separate TypeScript or Python processes. They claim attempts, stage bytes, observe cancellation, and propose results through the worker protocol. They never receive PostgreSQL credentials and never commit authoritative runtime truth.

```text
Control API and SSE
        │
        ▼
Factory Floor control plane
  registration  topology  scheduler
  delivery      execution policy
  capabilities  artifacts projections
        │                 │
        ▼                 ▼
    PostgreSQL      artifact blob store
        │
        ▼
TypeScript and Python workers
```

An in-process event bus can improve local coordination, but it is never the source of runtime truth. Durable records and PostgreSQL transactions define what happened.

## Trust boundaries

The control plane validates untrusted worker output, model output, topology requests, artifact content, external responses, human-provided artifacts, and unbundled templates before interpreting or committing them.

Only the control plane can:

- finalize artifact metadata;
- append authoritative events;
- update durable lifecycle state;
- create downstream deliveries;
- account resource usage;
- authorize external actions.

This boundary makes enforcement independent of worker compliance.

## Why the runtime keeps separate identities

A command requests a transition or execution. An event states that something occurred. A delivery routes one accepted command or event to one input. An execution is the logical computation for a trigger and input set. An attempt is one physical try.

```text
Command or event
  └─ Delivery
      └─ Execution
          ├─ Attempt 1
          ├─ Attempt 2
          └─ Attempt 3
```

Retries, leases, fan-out, fan-in, deduplication, replay, and forensic inspection need these identities to remain distinct.

## Why commits are transactional

Workers may stage immutable bytes before the control plane commits a result. The control plane then validates the active lease, lifecycle epoch, schemas, ports, provenance, and authority in one PostgreSQL transaction.

That transaction publishes artifact metadata, execution outputs, events, downstream deliveries, resource entries, external-action proposals, and terminal state together. Blob promotion occurs afterward and is idempotently reconciled. A failure during promotion does not rewrite committed metadata.

Failed attempts retain failure information and partial staged artifacts. A retry creates a new attempt rather than erasing history.

## Lifecycle, topology, and policy

Regions carry monotonically increasing lifecycle epochs. Cancellation increments the epoch, stops new dispatch for the old epoch, signals workers, preserves late results diagnostically, and rejects stale normal commits.

Topology is immutable and versioned per region. An execution retains the topology revision that dispatched it. Dynamic regions cannot modify ancestor topology; bounded dynamic construction is a later milestone.

Policy decisions are durable and deterministic. Outcomes follow `deny > require-approval > modify > allow`; modifications may only narrow authority or resources. Capabilities are opaque, scoped, durable grants resolved through short-lived handles.

External writes are reconciled protocols with idempotency keys rather than unrecorded worker side effects. After restart, dispatching or indeterminate actions are reconciled before retry.

## Recovery and observability

On startup, the control plane verifies migrations, abandons expired attempts, makes retryable work available, resumes projection checkpoints, reconciles artifact locations and uncertain external actions, resumes cancellation, and emits a durable recovery summary.

Historical projection replay reads durable history without dispatching workers or repeating external actions. Operator explanations derive from routing, policy, capability, execution, and artifact records; private model reasoning is not required.

See the [runtime contract reference](../reference/runtime-contract.md) for stable facts and the [architecture decisions](architecture-decisions.md) for the decisions and consequences behind this design.
