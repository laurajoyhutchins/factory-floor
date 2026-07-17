# Worker HTTP protocol v1

**Type:** Reference
**Status:** Frozen for protocol version `1.0`

All worker routes are rooted at `/worker/v1` and require `Authorization: Bearer <worker-token>`. Worker credentials are separate from operator and public APIs through `WORKER_API_BEARER_TOKEN`. Bearer credentials, lease tokens, upload URLs, upload handles, capability handles, and signed artifact URLs must not be logged.

Every JSON request is validated against the canonical Draft 2020-12 schema before the protocol service is called. Worker validation and error handling are scoped to `/worker/v1`; public and administrative APIs retain their own error formats.

| Operation              | Method and path                               | Success                                                                                       | Idempotency and stable errors                                                  |
| ---------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Claim                  | `POST /worker/v1/claim`                       | Returns an immutable `InvocationEnvelope`.                                                    | No work returns `claimed: false`; worker selectors use `name@version`.         |
| Heartbeat              | `POST /worker/v1/heartbeat`                   | Transactionally extends an active lease.                                                      | Repeating the same active lease is safe; stale or expired leases are rejected. |
| Observe cancellation   | `POST /worker/v1/cancellation`                | Returns `continue`, `cancellation_requested`, `lease_no_longer_valid`, or `attempt_terminal`. | Reads durable lifecycle state; repeats are safe.                               |
| Establish staging      | `POST /worker/v1/artifacts/stage`             | Returns an opaque `stagedRef` and short-lived upload URL.                                     | Each accepted call creates durable upload authorization.                       |
| Upload staged content  | `PUT /worker/v1/artifacts/upload/{stagedRef}` | Returns measured digest and size.                                                             | Identical bytes may repeat; conflicting bytes or metadata are rejected.        |
| Submit proposed result | `POST /worker/v1/results`                     | Returns `{ protocolVersion, accepted, duplicate, handoff }`.                                  | Identical retries return `duplicate: true`; conflicting retries return `409`.  |
| Invoke capability      | `POST /worker/v1/capabilities/invoke`         | Returns a capability result when a valid opaque handle is available.                          | Handles are bound to attempt, epoch, expiration, grantee, scope, and limits.   |

## Claim and invocation

`componentSelectors` in `WorkerClaimRequest` is the canonical allowlist of component implementations available in a worker process. The v1 `capabilities` field remains a deprecated compatibility name for the same selector list. An empty list claims no work, and the scheduler filters before leasing.

The invocation envelope contains protocol, execution, attempt, lease, lifecycle epoch, component, input artifact, state, capability, cancellation, heartbeat, result, staging, tracing, and execution-limit data. It excludes PostgreSQL coordinates and durable storage locators workers do not need.

The capability endpoint preserves the opaque-handle slot. Demonstration components do not receive minted grants; unknown handles are rejected conservatively.

## Artifact staging authority

The stage request names a declared output port and supplies media type, expected digest, expected byte count, and bounded metadata. The control plane derives schema identity from the registered output port rather than trusting a worker-supplied schema ID. Upload authorization is bound to execution, attempt, lease epoch, port, digest, size, media type, schema, and expiration.

Uploads use `application/octet-stream` and stream into the configured `ArtifactBlobStore`. A successful upload creates one immutable `artifact_staging` record. Repeating identical content is idempotent.

## Lease, retry, and cancellation rules

Every mutating operation except claim requires execution ID, attempt ID, active lease token, and lifecycle epoch. Lease checks and heartbeat extension lock the attempt transactionally. Normal operations require execution and region epochs to match. Cancellation observation recognizes a newer cancelling epoch and reports `cancellation_requested` to the old invocation.

Expired leases, stale tokens, inactive attempts, and terminal attempts are rejected deterministically. Cancellation comes from authoritative PostgreSQL lifecycle state, not process-local signaling.

## Proposed-result handoff

`POST /worker/v1/results` validates the active lease, lifecycle epoch, and each staged artifact's digest, size, media type, schema identity, schema digest, and attempt ownership. The proposed result is hashed using canonical JSON and inserted with a unique attempt key.

The endpoint records the proposal. It does not publish committed artifacts, downstream deliveries, resource-ledger entries, or terminal runtime truth.

## Schemas and limits

Canonical schemas live under `contracts/schemas/` and `contracts/schemas/worker/`; generated TypeScript and Python contracts are derived from them. Shared fixtures live under `contracts/fixtures/worker/`.

The local default worker lease is 60,000 ms. Workers should heartbeat before half the lease interval. A single artifact upload is bounded to 104,857,600 bytes.
