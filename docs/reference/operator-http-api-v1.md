# Operator HTTP API v1

**Status:** Stable authenticated boundary for trusted operator adapters  
**Base path:** `/api/v1/operator`

The operator HTTP API exposes the transport-neutral `OperatorCommandService` and `OperatorQueryService` to trusted adapters such as Discord Agent. Factory Floor remains authoritative for commands, run state, approvals, cancellation, events, and artifacts.

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

Keep the control plane on a private interface or behind a private authenticated tunnel. Do not compile either bearer token into a browser application.

## Required attribution headers

Every operator request must include:

```http
Authorization: Bearer <operator token>
X-Factory-Floor-Principal-Id: <stable external principal id>
X-Factory-Floor-Adapter: <stable adapter id>
```

Examples:

```http
X-Factory-Floor-Principal-Id: discord:user:1234567890
X-Factory-Floor-Adapter: discord-agent
```

The principal and adapter are recorded in durable operator command attribution. The principal value is limited to 200 characters and the adapter value to 100 characters.

Missing or invalid attribution returns `400 Bad Request` with a stable error code such as `operator_principal_required` or `operator_adapter_required`.

## Endpoints

| Method | Path                                              | Purpose                                |
| ------ | ------------------------------------------------- | -------------------------------------- |
| `GET`  | `/api/v1/operator/status`                         | Factory health and active-work summary |
| `POST` | `/api/v1/operator/tasks`                          | Submit a development task              |
| `GET`  | `/api/v1/operator/runs/:runId`                    | Read canonical run status              |
| `GET`  | `/api/v1/operator/runs/:runId/trace`              | Read the bounded durable run trace     |
| `GET`  | `/api/v1/operator/runs/:runId/artifacts`          | List artifacts produced by the run     |
| `GET`  | `/api/v1/operator/artifacts/:artifactId`          | Read bounded textual artifact content  |
| `GET`  | `/api/v1/operator/approvals`                      | List pending approvals                 |
| `POST` | `/api/v1/operator/approvals/:approvalId/decision` | Approve or reject a pending action     |
| `POST` | `/api/v1/operator/runs/:runId/cancel`             | Cancel only the selected run graph     |

List endpoints accept `limit` and opaque `cursor` query parameters. Artifact reads accept `maxBytes`, bounded by the runtime to 1 MiB.

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

| HTTP status | Meaning                                      |
| ----------- | -------------------------------------------- |
| `400`       | Malformed input or operator validation error |
| `401`       | Bearer token missing                         |
| `403`       | Token or operator authorization denied       |
| `404`       | Run, artifact, or approval not found         |
| `409`       | Idempotency or durable-state conflict        |
| `422`       | Development task rejected by command policy  |
| `500`       | Unexpected internal error                    |

Unexpected errors are logged server-side and returned only as `internal_error`; implementation details are not exposed to clients.

## Adapter persistence boundary

An adapter should persist only the binding needed to recover its presentation after restart:

- Factory Floor run ID;
- installation or project identity;
- external channel, thread, message, or interaction identifiers;
- initiating principal ID;
- last rendered state and last successful refresh time.

Factory Floor remains the source of truth. After restart, re-read canonical run status rather than inferring completion from adapter-local state.
