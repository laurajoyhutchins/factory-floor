# Operator HTTP API v1

**Status:** Stable authenticated boundary for trusted operator adapters  
**Base path:** `/api/v1/operator`

The operator HTTP API exposes the transport-neutral `OperatorCommandService` and `OperatorQueryService` to trusted adapters. Factory Floor remains authoritative for commands, run state, approvals, cancellation, topology, alerts, events, and artifacts. Clients render and route that state; they do not maintain a second runtime.

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

The static operator-token path used by the standalone console remains supported for trusted private deployments. Embedded browser hosts should inject a short-lived host session through their shell rather than compile the operator token into a public bundle.

## Required attribution headers

Every operator request must include:

```http
Authorization: Bearer <operator token>
X-Factory-Floor-Principal-Id: <stable external principal id>
X-Factory-Floor-Adapter: <stable adapter id>
```

The principal and adapter are recorded for operator commands and are required for operator queries so every adapter access remains attributable. The principal value is limited to 200 characters and the adapter value to 100 characters.

Missing or invalid attribution returns `400 Bad Request` with a stable error code such as `operator_principal_required` or `operator_adapter_required`.

## Endpoints

| Method | Path                                                 | Purpose                                           |
| ------ | ---------------------------------------------------- | ------------------------------------------------- |
| `GET`  | `/api/v1/operator/status`                            | Factory health and active-work summary            |
| `POST` | `/api/v1/operator/tasks`                             | Submit a development task                         |
| `GET`  | `/api/v1/operator/runs/:runId`                       | Read canonical run status                         |
| `GET`  | `/api/v1/operator/runs/:runId/trace`                 | Read the bounded durable run trace                |
| `GET`  | `/api/v1/operator/runs/:runId/topology`              | Read topology and runtime relationships for a run |
| `GET`  | `/api/v1/operator/runs/:runId/alerts`                | Read current durable operational conditions       |
| `GET`  | `/api/v1/operator/runs/:runId/events`                | Read a finite resumable event page                |
| `GET`  | `/api/v1/operator/runs/:runId/instantiations`        | List template instantiations attributable to run  |
| `GET`  | `/api/v1/operator/runs/:runId/artifacts`             | List artifacts produced by the run                |
| `GET`  | `/api/v1/operator/runs/:runId/artifacts/:artifactId` | Read a run-owned bounded textual artifact         |
| `GET`  | `/api/v1/operator/approvals`                         | List pending approvals                            |
| `POST` | `/api/v1/operator/approvals/:approvalId/decision`    | Approve or reject a pending action                |
| `POST` | `/api/v1/operator/runs/:runId/cancel`                | Cancel only the selected run graph                |

List endpoints accept `limit` and opaque `cursor` query parameters. Artifact reads accept `maxBytes`, bounded by the runtime to 1 MiB.

The former unscoped artifact path is intentionally absent. Clients must provide both the run ID and artifact ID so the service can verify ownership without revealing whether an artifact exists in another run.

## Run isolation

A run is identified by its accepted command ID and durable correlation ID. Run-scoped queries first resolve that command and then select runtime records only through its correlation boundary. A response never includes deliveries, executions, events, or artifacts from another correlation.

Topology definitions are included only when their revision was referenced by a delivery or execution in the selected run. The response can include all component instances and connections in those referenced revisions because those definitions are the immutable execution context for the run. Runtime delivery and execution records remain strictly run-filtered.

A cross-run artifact lookup returns `artifact_not_found`. This deliberately does not distinguish a missing artifact from an artifact owned by a different run.

## Run topology

`GET /api/v1/operator/runs/:runId/topology` returns:

- the selected run summary;
- regions and immutable topology revisions used by the run;
- component instances, definitions, ports, and connections from those revisions;
- run-filtered deliveries and executions;
- explicit connection, delivery-target, execution-delivery, and execution-component relationships;
- the effective response bounds.

Supported bounds are:

| Query parameter   | Default | Maximum |
| ----------------- | ------: | ------: |
| `regionLimit`     |      25 |     100 |
| `componentLimit`  |     250 |   1,000 |
| `connectionLimit` |     500 |   2,000 |
| `recordLimit`     |     500 |   2,000 |

A bound violation returns a stable validation code such as `topology_component_bound_exceeded`. Clients should narrow the selected run or request a larger documented bound rather than retry indefinitely.

## Alert projection

`GET /api/v1/operator/runs/:runId/alerts` derives a current projection from canonical durable records. It does not create a second alert store. Stable alert kinds are:

- `approval_required`;
- `blocked_work`;
- `repeated_failure`;
- `budget_pressure`;
- `dead_letter`;
- `projection_stale`;
- `execution_failed`.

Alert IDs are deterministic from their durable source. Ordering is deterministic by severity, kind, and ID. An alert disappears when its canonical condition clears—for example, when a blocked region resumes or a pending approval is decided.

Budget pressure is reported when a run-attributed resource-ledger row contains a positive integer `budgetLimit` or `budget_limit` attribute and usage reaches at least 80 percent. Projection staleness uses the durable global projection checkpoint and a 60-second freshness window; the alert reveals only projection identity and age, not another run's records.

Alert cursors identify an item in the current projection. If that source condition clears before the next page, the cursor returns `cursor_expired`; restart pagination from the beginning.

## Finite run events

`GET /api/v1/operator/runs/:runId/events` returns a bounded JSON page rather than holding an HTTP connection open:

```json
{
  "items": [],
  "nextCursor": null,
  "resumeCursor": null,
  "complete": true
}
```

Semantics:

- events are ordered by immutable UUIDv7 event ID;
- `limit` defaults to 25 and is bounded to 100;
- `nextCursor` is present only when another page was already available;
- `resumeCursor` identifies the last delivered event even after the client catches up;
- `complete: true` means the response reached the end visible to that request, not that the run itself is terminal;
- poll using `resumeCursor` to receive later events;
- deduplicate by event `id` across retries or reconnects.

Cursors are opaque, versioned, endpoint-specific, and bound to the run ID. A cursor from another run returns `cursor_run_mismatch`. Malformed data returns `invalid_cursor`. If the cursor anchor is no longer retained, the service returns `cursor_expired`; restart from the beginning or re-read canonical run status before deciding how much history to replay.

Runtime events are currently append-only and Factory Floor does not automatically prune them. The explicit expired-cursor behavior is retained so a future configured retention policy can remove old events without changing the client contract.

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

The returned `runId` is the durable identity the adapter must persist. Reusing the same principal and `clientRequestId` replays the original submission instead of creating duplicate work.

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

Cancellation is scoped to the selected run correlation. It does not cancel unrelated work in the same region, and stale worker results are fenced after cancellation.

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
| `403`       | Token or operator authorization denied                      |
| `404`       | Run, run-owned artifact, or approval not found              |
| `409`       | Idempotency or durable-state conflict                       |
| `422`       | Development task rejected by command policy                 |
| `500`       | Unexpected internal error                                   |

Unexpected errors are logged server-side and returned only as `internal_error`; implementation details are not exposed to clients.

## Adapter persistence boundary

An adapter should persist only the binding needed to recover its presentation after restart:

- Factory Floor run ID;
- installation or project identity;
- external channel, thread, message, or interaction identifiers;
- initiating principal ID;
- last event `resumeCursor`;
- last rendered state and last successful refresh time.

Factory Floor remains the source of truth. After restart, re-read canonical run status and alerts rather than inferring completion from adapter-local state.
