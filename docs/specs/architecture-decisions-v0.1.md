# Factory Floor Architecture Decisions v0.1

**Date:** 2026-07-14  
**Status:** Accepted for the reference implementation

These decisions close the design questions required to begin implementation. Changes require an explicit ADR rather than silent drift.

## ADR-001: Transactional modular monolith

**Decision:** Build one control-plane deployable with internal modules sharing PostgreSQL transactions.

**Reason:** The central problem is semantic correctness across events, artifacts, attempts, topology, and accounting. A modular monolith provides a real atomic commit boundary and keeps infrastructure from obscuring the model.

**Consequences:** Modules must have explicit interfaces and no table access outside their owning repository layer. Logical boundaries should remain extractable later.

## ADR-002: Split TypeScript control plane and external workers

**Decision:** TypeScript owns authoritative runtime logic. TypeScript and Python workers run as separate processes and communicate through a versioned protocol.

**Reason:** TypeScript provides strong API and UI ergonomics. Python provides the scientific and model ecosystem. Process isolation allows dependency, failure, and resource boundaries.

**Consequences:** No embedded Python interpreter in the control plane. No shared process memory as durable state.

## ADR-003: PostgreSQL is the coordination source of truth

**Decision:** Use PostgreSQL for event records, deliveries, leases, executions, attempts, topology, capabilities, policy decisions, approvals, accounting, and projection checkpoints.

**Reason:** PostgreSQL supplies transactions, row locks, `SKIP LOCKED`, indexing, JSONB, and operational maturity without introducing a broker.

**Consequences:** The event stream is a durable table, not a claim that the database is a globally ordered log. Ordering is defined per region or selected stream key.

## ADR-004: Separate commands, events, deliveries, executions, and attempts

**Decision:** Persist each as a separate entity.

**Reason:** Retries, fan-out, queue leases, deduplication, replay, and competing consumers have different identities and lifecycles.

**Consequences:** APIs and traces must expose the distinctions rather than collapsing them into “runs.”

## ADR-005: Workers propose; control plane commits

**Decision:** Workers may stage artifacts and submit proposed results. Only the control plane may finalize artifacts, append authoritative events, update state, create downstream deliveries, account resources, or authorize external actions.

**Reason:** Runtime invariants cannot depend on worker compliance.

**Consequences:** Worker credentials cannot reach PostgreSQL or committed blob namespaces directly.

## ADR-006: Transactional execution commit

**Decision:** One PostgreSQL transaction publishes all metadata effects of a successful attempt.

**Reason:** The user-visible result must not contain committed events without artifacts, completed executions without accounting, or downstream deliveries without durable outputs.

**Consequences:** Blob bytes are staged before commit and promoted idempotently after commit. Reconciliation handles promotion failure.

## ADR-007: JSON Schema is authoritative

**Decision:** JSON Schema Draft 2020-12 defines envelopes, artifacts, configuration, templates, and policy inputs.

**Reason:** It is language-neutral and supports validation before interpretation.

**Consequences:** TypeScript and Python types are generated. Runtime acceptance depends on schema validation, not static types alone.

## ADR-008: Immutable, versioned topology

**Decision:** Every accepted local graph change creates a complete topology revision.

**Reason:** Executions must be explainable under the graph that dispatched them, and replay cannot depend on current topology.

**Consequences:** Existing executions retain their revision. Dynamic regions cannot change ancestor revisions.

## ADR-009: Lifecycle epochs fence cancellation

**Decision:** Regions have monotonically increasing lifecycle epochs. Cancellation increments the epoch and invalidates stale normal commits.

**Reason:** Cancellation races with active workers and external actions.

**Consequences:** Late output may be retained diagnostically but does not satisfy completion or publish downstream work.

## ADR-010: Deterministic policy composition

**Decision:** Outcome precedence is `deny > require-approval > modify > allow`. Modifications may only narrow authority or resources.

**Reason:** Policy interaction must be reproducible and auditable.

**Consequences:** Non-comparable modification conflicts deny rather than guess.

## ADR-011: Capabilities are opaque, scoped handles

**Decision:** Workers receive short-lived handles; adapters resolve them against durable grants.

**Reason:** Components must not mint, enlarge, or directly inspect credentials.

**Consequences:** Secrets stay outside artifacts and ordinary logs.

## ADR-012: External actions are reconciled protocols

**Decision:** External writes are durable state machines with idempotency keys and reconciliation.

**Reason:** A crash can occur after an external system accepts an action but before the runtime records success.

**Consequences:** No irreversible action is performed as an unrecorded side effect inside worker completion.

## ADR-013: Operator console before builder

**Decision:** The first UI supports operation, inspection, playback, approvals, and artifact lineage. System definitions remain YAML or programmatic configuration.

**Reason:** The runtime model should be validated before freezing a visual authoring metaphor.

**Consequences:** Read-mostly APIs and projections are prioritized over drag-and-drop editing.

## ADR-014: Server-Sent Events for live updates

**Decision:** Use SSE in v0.1.

**Reason:** The first console needs one-way durable update notifications, not general bidirectional sessions.

**Consequences:** Commands and approvals remain ordinary HTTP requests. A later ADR may introduce WebSockets.

## ADR-015: No Kafka, Temporal, or Kubernetes operator in v0.1

**Decision:** Do not add them to the first implementation.

**Reason:** Each would introduce a second execution or coordination model before Factory Floor’s own semantics are proven.

**Consequences:** Reconsider only after conformance tests, profiling, and operational evidence demonstrate a specific need.
