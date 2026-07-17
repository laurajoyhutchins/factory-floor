# Runtime Terminology Glossary v0.1

This glossary records canonical Factory Floor runtime terms. Public v1 wire names and existing database columns may retain older compatibility names; adapters translate them at module boundaries.

## Canonical terms

- **Component definition**: immutable versioned declaration of executable behavior, ports, schemas, and configuration shape.
- **Component instance**: topology-local placement of a component definition with instance configuration.
- **Component selector**: `name@version` selector for a component definition a worker implementation can execute, such as `retrieve@1`.
- **Capability**: governed runtime authority for external or privileged actions, represented by capability definitions, grants, handles, policies, and authorization decisions.
- **Capability grant**: durable delegation that allows a component definition to request a governed capability under policy.
- **Worker**: external process that leases attempts, stages artifacts, and proposes results; it does not commit authoritative runtime truth.
- **Delivery**: durable routed input message for a target component input port.
- **Execution**: durable operation created from one trigger delivery and its complete selected input set.
- **Execution attempt**: one leased try to perform an execution; retries create additional attempts and preserve prior history.
- **Lease**: time-bounded ownership token for delivery dispatch or attempt execution.
- **Trigger delivery**: the selected delivery stored in `executions.delivery_id`; complete execution inputs are stored in `execution_inputs`.
- **Region fencing epoch**: monotonic fencing token stored on region and execution rows as `lifecycle_epoch`; stale epochs identify work from an obsolete region incarnation.
- **Staging reference**: worker-visible opaque artifact reference stored as `artifact_staging.staged_ref`; it is not the `artifact_staging.id` row primary key.
- **Artifact**: immutable content-addressed runtime data with schema, digest, locator, state, and provenance.
- **State**: durable lifecycle value of an entity, for example execution state or artifact-staging state.
- **Outcome**: result of a completed operation or policy evaluation.
- **Disposition**: request-handling classification such as created, existing, replayed, duplicate, or rejected.
- **Projection checkpoint**: durable cursor for a read-model projection stream; advancing a checkpoint is distinct from rebuilding the projection data.

## Do not confuse

- **Component selectors versus capabilities**: component selectors match worker executable component definitions; capabilities authorize governed external authority.
- **Execution versus attempt**: an execution is the durable unit of work; an attempt is one leased try to complete it.
- **Delivery lease versus attempt lease**: delivery leases protect queue dispatch; attempt leases protect worker execution and result submission.
- **Staging row ID versus staging reference**: `artifact_staging.id` identifies the database row; `artifact_staging.staged_ref` is the worker-visible reference used in protocol results.
- **Lifecycle status versus region fencing epoch**: lifecycle status describes entity state; the region fencing epoch prevents stale work from committing after cancellation or replacement.
- **Projection checkpoint advancement versus projection rebuilding**: checkpoint movement records consumed stream position; rebuilding reconstructs projection state from source records.
