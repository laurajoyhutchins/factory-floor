# Operator HTTP API v1

**Status:** Stable authenticated boundary for trusted operator adapters  
**Base path:** `/api/v1/operator`

The operator HTTP API exposes the transport-neutral `OperatorCommandService` and `OperatorQueryService` to trusted adapters. Factory Floor remains authoritative for commands, deliveries, executions, attempts, approvals, cancellation, topology, alerts, events, and artifacts. Clients render and route that state; they do not maintain a second runtime.

ADR-004 requires commands, events, deliveries, executions, and attempts to keep distinct durable identities. The operator API therefore uses the accepted command ID as its public scope root. Correlation IDs remain internal grouping metadata and are never accepted as an authorization root or public route identity.

The broader Discord Activity architecture is described in [Discord Activity operator interface](../explanation/discord-activity-operator-interface.md).

## Authentication and scope

Configure distinct bearer tokens:

```dotenv
CONTROL_PLANE_OPERATOR_TOKEN=replace-with-a-long-random-operator-token
CONTROL_PLANE_ADMIN_TOKEN=replace-with-a-different-long-random-admin-token
```

The operator token authorizes:

- read-only inspection requests under `GET /api/v1/inspect/*`;
- all methods under `/api/v1/operator/*`.

Registration, system application, generic command submission, projection rebuild, and other mutation namespaces remain admin-only. A trusted adapter should receive only the operator token unless it separately requires administrative access.

The static operator-token path used by the standalone console remains supported for trusted private deployments. Embedded browser hosts use short-lived host sessions rather than compiling the operator token into a public bundle.

## Required attribution headers

Every statically authenticated operator request must include:

```http
Authorization: Bearer <operator token>
X-Factory-Floor-Principal-Id: <stable external principal id>
X-Factory-Floor-Adapter: <stable adapter id>
```

The principal and adapter are recorded for operator commands and required for operator queries so adapter access remains attributable. The principal value is limited to 200 characters and the adapter value to 100 characters.

Missing or invalid attribution returns `400 Bad Request` with a stable error code such as `operator_principal_required` or `operator_adapter_required`.

A valid Discord Activity bearer is a separate read-only authorization path. Factory Floor resolves the server-side Activity session, requires the requested command ID to equal the session's immutable bound command ID, overrides browser-supplied attribution with the session principal and adapter, and rejects a different command with `activity_command_binding_mismatch`.

## Endpoints

| Method | Path                                                         | Purpose                                               |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------- |
| `GET`  | `/api/v1/operator/status`                                    | Factory health and active-work summary                |
| `POST` | `/api/v1/operator/tasks`                                     | Submit a development task                             |
| `GET`  | `/api/v1/operator/commands/:commandId`                       | Read canonical command status                         |
| `GET`  | `/api/v1/operator/commands/:commandId/details`               | Read bounded governance, resource, and lineage detail |
| `GET`  | `/api/v1/operator/commands/:commandId/trace`                 | Read the bounded durable command trace                |
| `GET`  | `/api/v1/operator/commands/:commandId/topology`              | Read topology and runtime relationships               |
| `GET`  | `/api/v1/operator/commands/:commandId/alerts`                | Read current durable operational conditions           |
| `GET`  | `/api/v1/operator/commands/:commandId/events`                | Read a finite resumable event page                    |
| `GET`  | `/api/v1/operator/commands/:commandId/instantiations`        | List template instantiations attributable to command  |
| `GET`  | `/api/v1/operator/commands/:commandId/artifacts`             | List artifacts attributable to the command            |
| `GET`  | `/api/v1/operator/commands/:commandId/artifacts/:artifactId` | Read a bounded command-owned textual artifact         |
| `GET`  | `/api/v1/operator/approvals`                                 | List pending approvals                                |
| `POST` | `/api/v1/operator/approvals/:approvalId/decision`            | Approve or reject a pending action                    |
| `POST` | `/api/v1/operator/commands/:commandId/cancel`                | Cancel only the selected command graph                |

List endpoints accept `limit` and opaque `cursor` query parameters. Artifact reads accept `maxBytes`, bounded by the runtime to 1 MiB. Command details accept an optional bounded `limit`.

The legacy `/api/v1/operator/runs/*` surface is intentionally absent. The former unscoped artifact path is also absent. Clients must provide both command ID and artifact ID so the service can verify ownership without revealing whether an artifact exists outside the selected command scope.

## Durable command isolation

The accepted command ID is the public operator identity. Query services may use persisted correlation metadata internally to recover historical records, but that correlation value is not a public identity and cannot grant access.

A command-scoped response is assembled only from records attributable to that command. The public model preserves the real runtime distinctions:

`command → delivery → execution → attempt`

Executions and attempts keep their own durable IDs. A command ID is not rewritten into a synthetic execution/run identity, and a correlation ID is never treated as an execution ID or authorization token.

Topology definitions may be included when their revision was referenced by a delivery or execution attributable to the selected command. Those definitions are immutable execution context. Runtime delivery and execution records remain command-filtered.

A cross-command artifact lookup returns `artifact_not_found`. This deliberately does not distinguish a missing artifact from an artifact attributable to a different command.

## Command topology

`GET /api/v1/operator/commands/:commandId/topology` returns:

- the selected command summary;
- regions and immutable topology revisions used by attributable work;
- component instances, definitions, ports, and connections from those revisions;
- command-attributed deliveries and executions;
- explicit connection, delivery-target, execution-delivery, and execution-component relationships;
- the effective response bounds.

Supported bounds are:

| Query parameter   | Default | Maximum |
| ----------------- | ------: | ------: |
| `regionLimit`     |      25 |     100 |
| `componentLimit`  |     250 |   1,000 |
| `connectionLimit` |     500 |   2,000 |
| `recordLimit`     |     500 |   2,000 |

A bound violation returns a stable validation code such as `topology_component_bound_exceeded`. Clients should narrow the selected command or request a larger documented bound rather than retry indefinitely.

## Command details

`GET /api/v1/operator/commands/:commandId/details` returns a bounded command-scoped view of approvals, policy decisions, resource-ledger entries, artifact derivations, and control-plane projection freshness. The payload is identified by `commandId`, not `runId`.

Projection freshness is explicitly control-plane-global. It is operational context, not evidence that unrelated runtime records belong to the selected command.

## Alert projection

`GET /api/v1/operator/commands/:commandId/alerts` derives a current projection from canonical durable records. It does not create a second alert store. Stable alert kinds include:

- `approval_required`;
- `blocked_work`;
- `repeated_failure`;
- `budget_pressure`;
- `dead_letter`;
- `projection_stale`;
- `execution_failed`.

Alert IDs are deterministic from their durable source. Ordering is deterministic by severity, kind, and ID. An alert disappears when its canonical condition clears.

Projection staleness may use a durable global projection checkpoint, but the alert reveals only projection identity and age, not another command's runtime records.

Alert cursors identify an item in the current projection. If that source condition clears before the next page, the cursor returns `cursor_expired`; restart pagination from the beginning.

## Finite command events

`GET /api/v1/operator/commands/:commandId/events` returns a bounded JSON page rather than holding an HTTP connection open:

```json
{
  "items": [],
  "nextCursor": null,
  "resumeCursor": null,
  "complete": true
}
```

Semantics:

- events are ordered by immutable event ID;
- `limit` defaults to 25 and is bounded;
- `nextCursor` is present only when another page was already available;
- `resumeCursor` identifies the last delivered event even after the client catches up;
- `complete: true` means the response reached the end visible to that request, not that the command itself is terminal;
- poll using `resumeCursor` to receive later events;
- deduplicate by event `id` across retries or reconnects.

Cursors are opaque, versioned, endpoint-specific, and bound to the command scope. Malformed data returns `invalid_cursor`. If the cursor anchor is no longer retained, the service returns `cursor_expired`; restart from the beginning or re-read canonical command status before deciding how much history to replay.

Runtime events are currently append-only and Factory Floor does not automatically prune them. Explicit expired-cursor behavior preserves a stable client contract if retention is configured later.

## Task submission

```json
{
  "clientRequestId": "external-message-or-interaction-id",
  "repository": "laurajoyhutchins/factory-floor",
  "objective": "Implement the requested change and open a draft pull request.",
  "acceptanceCriteria": [
    "Relevant tests pass.",
    "The pull request remains a draft for review."
  ],
  "authority": {
    "mayCreateBranch": true,
    "mayOpenDraftPullRequest": true,
    "mayMerge": false
  },
  "metadata": {
    "channelId": "...",
    "threadId": "...",
    "messageId": "..."
  }
}
```

The returned `commandId` is the durable operator identity the adapter must persist. Reusing the same principal and `clientRequestId` replays the original submission instead of creating duplicate work.

Factory Floor deliberately refuses merge authority at this boundary. A later explicit user action may merge through a separately authorized workflow.

## Approval decisions

```json
{
  "clientRequestId": "external-interaction-id",
  "decision": "approve",
  "reason": "Approved by the repository owner."
}
```

Equivalent retries are idempotent. A reused request ID with different content, a stale decision, or a decision against a different approval returns `409 Conflict`.

## Cancellation

```json
{
  "clientRequestId": "external-interaction-id",
  "reason": "Cancelled by the repository owner."
}
```

Cancellation is requested through `POST /api/v1/operator/commands/:commandId/cancel`. It is scoped to work attributable to the selected command and does not cancel unrelated work. The public command service exposes `cancelCommand`; any internal legacy `cancelRun` adapter is persistence compatibility only and is not part of the operator API.

## Request validation

Mutation bodies are strict JSON objects. Required fields must have the documented JSON types, nested authority flags must be booleans, metadata values must be JSON primitives or `null`, and unknown top-level fields are rejected.

Malformed bodies return:

```json
{
  "error": {
    "code": "malformed_operator_request",
    "message": "malformed_operator_request"
  }
}
```

Domain validation remains in the operator services and may return more specific codes such as `invalid_repository`, `objective_required`, `invalid_decision`, or `reason_required`.

## Error mapping

| HTTP status | Meaning                                                     |
| ----------- | ----------------------------------------------------------- |
| `400`       | Malformed input, invalid/expired cursor, or bound violation |
| `401`       | Bearer token missing                                        |
| `403`       | Token, Activity binding, or operator authorization denied   |
| `404`       | Command, command-owned artifact, or approval not found      |
| `409`       | Idempotency or durable-state conflict                       |
| `422`       | Development task rejected by command policy                 |
| `500`       | Unexpected internal error                                   |

Unexpected errors are logged server-side and returned only as `internal_error`; implementation details are not exposed to clients.

## Adapter persistence boundary

An adapter should persist only the binding needed to recover its presentation after restart:

- Factory Floor command ID;
- installation or project identity;
- external channel, thread, message, or interaction identifiers;
- initiating principal ID;
- last event `resumeCursor`;
- last rendered state and last successful refresh time.

Factory Floor remains the source of truth. After restart, re-read canonical command status and alerts rather than inferring completion from adapter-local state.
