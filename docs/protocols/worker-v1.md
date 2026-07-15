# Worker HTTP Protocol v1

Status: frozen for Task 7A. Protocol version is `1.0`. All worker routes are rooted at `/worker/v1` and require `Authorization: Bearer <worker-token>`. Worker tokens are configured separately from operator/public APIs with `WORKER_API_BEARER_TOKEN`; bearer credentials, lease tokens, upload handles, capability handles, and URLs must not be logged.

| Operation | Method path | Success | No-work / idempotency | Error codes |
|---|---|---|---|---|
| Claim | `POST /worker/v1/claim` | `WorkerClaimResponse` with `claimed: true` and immutable `InvocationEnvelope` | `200 {protocolVersion:"1.0", claimed:false, retryAfterMs}`; at-least-once, no duplicate logical execution | `authentication_failure`, `invalid_request`, `unsupported_protocol_version`, `internal_transient_failure` |
| Heartbeat | `POST /worker/v1/heartbeat` | `WorkerHeartbeatResponse` and extended lease | Safe repeat extends same active lease using service policy | `inactive_attempt`, `lease_expired`, `stale_lease_token`, `stale_lifecycle_epoch`, `cancellation_requested` |
| Observe cancellation | `POST /worker/v1/cancellation` | `WorkerCancellationResponse` state: `continue`, `cancellation_requested`, `lease_no_longer_valid`, or `attempt_terminal` | Safe repeat | same lease/epoch codes as heartbeat |
| Establish artifact staging | `POST /worker/v1/artifacts/stage` | `WorkerStageResponse` with opaque `stagedRef` and upload URL | Retrying creates a new handle unless a previous handle is reused for upload | `unauthorized_staging_reference`, lease/epoch errors |
| Upload staged content | `PUT /worker/v1/artifacts/upload/{stagedRef}` | `WorkerUploadResponse` with computed digest and size | Safe repeat for identical bytes and metadata; digest/size mismatch rejected | `unauthorized_staging_reference`, `invalid_request`, lease/epoch errors |
| Submit proposed result | `POST /worker/v1/results` | `{ protocolVersion, accepted, duplicate, handoff }` | Identical retry is accepted with `duplicate:true`; conflicting second submission returns conflict | `duplicate_conflicting_result`, `unauthorized_staging_reference`, lease/epoch errors |
| Invoke capability | `POST /worker/v1/capabilities/invoke` | `WorkerCapabilityResponse` | Capability handles are opaque and bounded by attempt, epoch, expiration, grantee, scope, and usage limit | `capability_denied`, lease/epoch errors |

## Invocation envelope

The envelope contains: protocol version; execution ID; attempt ID and attempt number; lease token and expiration; lifecycle epoch; component instance ID, definition identity, immutable definition and configuration; declared input payloads and artifact descriptors/read URLs; optional state; opaque capability handles; heartbeat, cancellation, result, artifact staging, and capability URLs; tracing context; and execution limits. It intentionally excludes PostgreSQL coordinates and durable storage locators workers do not need.

## Request and response schemas

Canonical JSON Schemas live under `contracts/schemas/` and `contracts/schemas/worker/`. They are JSON Schema Draft 2020-12 and are the source for generated TypeScript and Python contracts. Shared conformance fixtures live under `contracts/fixtures/worker/`.

## Retry, lease, and cancellation rules

Every mutating operation except claim requires execution ID, attempt ID, active lease token, and lifecycle epoch. Expired leases, stale lease tokens, stale lifecycle epochs, inactive attempts, and terminal attempts are rejected deterministically. Cancellation is derived from authoritative region lifecycle state rather than process-local signaling.

## Limits

Default worker lease duration is `WORKER_LEASE_DURATION_MS` (local default 60000 ms). Workers should heartbeat before half the lease interval. A single artifact upload is bounded by the schema-level maximum of 104857600 bytes in Task 7A. Route handlers stream request bodies to the artifact blob store rather than buffering artifact content in memory.

## Task 8 boundary

`POST /worker/v1/results` validates protocol identity, lease fencing, duplicate semantics, and staged-reference authority, then durably records the proposed result for the Task 8 atomic commit service. It does not publish committed artifacts, downstream deliveries, resource ledger entries, or terminal runtime truth in Task 7A.
