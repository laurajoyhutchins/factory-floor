# Worker HTTP Protocol v1

Status: frozen for Task 7A. Protocol version is `1.0`. All worker routes are rooted at `/worker/v1` and require `Authorization: Bearer <worker-token>`. Worker credentials are configured separately from operator/public APIs with `WORKER_API_BEARER_TOKEN`. Bearer credentials, lease tokens, upload URLs, upload handles, capability handles, and signed artifact URLs must not be logged.

Every JSON request is validated against the canonical Draft 2020-12 schema before the protocol service is called. Worker validation and error handling are scoped to `/worker/v1`; public and administrative APIs retain their own error formats.

| Operation | Method and path | Success | No-work / idempotency | Stable errors |
|---|---|---|---|---|
| Claim | `POST /worker/v1/claim` | `WorkerClaimResponse` with `claimed: true` and an immutable `InvocationEnvelope` | `200 { protocolVersion: "1.0", claimed: false, retryAfterMs }`; a worker is eligible only for component capabilities it advertises as `name@version` | `authentication_failure`, `invalid_request`, `unsupported_protocol_version`, `internal_transient_failure` |
| Heartbeat | `POST /worker/v1/heartbeat` | `WorkerHeartbeatResponse` with a transactionally extended lease | Safe repeat for the same active lease | `inactive_attempt`, `lease_expired`, `stale_lease_token`, `stale_lifecycle_epoch` |
| Observe cancellation | `POST /worker/v1/cancellation` | `WorkerCancellationResponse`: `continue`, `cancellation_requested`, `lease_no_longer_valid`, or `attempt_terminal` | Safe repeat; reads durable attempt and region lifecycle state | authentication and request errors |
| Establish artifact staging | `POST /worker/v1/artifacts/stage` | `WorkerStageResponse` with an opaque UUID `stagedRef` and short-lived upload URL | Each accepted call creates and durably records a new upload authorization | `unauthorized_staging_reference`, lease/epoch errors |
| Upload staged content | `PUT /worker/v1/artifacts/upload/{stagedRef}` | `WorkerUploadResponse` with measured digest and size | Identical bytes may be uploaded repeatedly to the same authorization; conflicting bytes or metadata are rejected | `unauthorized_staging_reference`, `invalid_request`, lease/epoch errors |
| Submit proposed result | `POST /worker/v1/results` | `{ protocolVersion, accepted, duplicate, handoff }` | Canonically identical retries return `duplicate: true`; a conflicting second result returns `409` without duplicating the durable handoff | `duplicate_conflicting_result`, `unauthorized_staging_reference`, lease/epoch errors |
| Invoke capability | `POST /worker/v1/capabilities/invoke` | `WorkerCapabilityResponse` when a valid opaque handle is available | Handles are bound to attempt, lifecycle epoch, expiration, grantee, scope, and usage limits | `capability_denied`, lease/epoch errors |

## Claim compatibility

`capabilities` in `WorkerClaimRequest` is an allowlist of component implementations available in that worker process. The canonical selector is the registered component definition `name@version`, for example `retrieve@1`. An empty list claims no work. The scheduler applies the filter before leasing, so an incompatible worker never takes ownership of an attempt.

## Invocation envelope

The envelope contains protocol version; execution ID; attempt ID and attempt number; lease token and expiration; lifecycle epoch; component instance ID, definition identity, immutable definition and configuration; declared input payloads and artifact descriptors/read URLs; optional state; opaque capability handles; heartbeat, cancellation, result, artifact-staging, and capability URLs; tracing context; and execution limits. It intentionally excludes PostgreSQL coordinates and durable storage locators workers do not need.

Task 7A creates the capability endpoint and preserves the opaque-handle slot, but does not mint grants for the demonstration components. Until a later capability service supplies handles, `capabilityHandles` is empty and invocation rejects unknown handles conservatively.

## Artifact staging authority

The stage request names a declared output port and supplies media type, expected digest, expected byte count, and bounded metadata. The control plane derives the artifact schema identity from the registered output port rather than trusting a worker-supplied schema ID. Before returning an upload URL, it persists an authorization bound to the execution, attempt, lease epoch, port, digest, size, media type, schema, and expiration.

The upload body uses `application/octet-stream` and is streamed into the configured `ArtifactBlobStore`; it is not buffered as a JSON request. The upload URL includes opaque lease-bound query parameters and must be treated as sensitive. A successful upload creates one immutable `artifact_staging` record. Repeating an identical upload is idempotent.

## Retry, lease, and cancellation rules

Every mutating operation except claim requires execution ID, attempt ID, active lease token, and lifecycle epoch. Lease checks and heartbeat extension lock the attempt transactionally. Normal operations require both the execution epoch and the current region epoch to match the invocation. Cancellation observation deliberately recognizes a newer cancelling region epoch and reports `cancellation_requested` to the old invocation.

Expired leases, stale lease tokens, inactive attempts, and terminal attempts are rejected deterministically. Cancellation is derived from authoritative PostgreSQL lifecycle state rather than process-local signaling.

## Proposed-result handoff

`POST /worker/v1/results` validates the active lease, current lifecycle epoch, and every staged artifact’s digest, size, media type, schema identity, schema digest, and attempt ownership. The proposed result is hashed using canonical JSON and inserted with a unique attempt key, making concurrent identical submission safe and a conflicting retry deterministic.

The endpoint durably records the proposal for Task 8. It does not publish committed artifacts, downstream deliveries, resource-ledger entries, or terminal runtime truth.

## Request and response schemas

Canonical JSON Schemas live under `contracts/schemas/` and `contracts/schemas/worker/`. They are JSON Schema Draft 2020-12 and are the source for generated TypeScript and Python contracts. Shared conformance fixtures live under `contracts/fixtures/worker/`.

## Limits

The default worker lease duration is `WORKER_LEASE_DURATION_MS` (60,000 ms in local development). Workers should heartbeat before half the lease interval. Task 7A bounds a single artifact upload to 104,857,600 bytes through the request schema and artifact-store verification.
