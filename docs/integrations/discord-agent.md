# Discord Agent Integration

Discord Agent integrates with Factory Floor through the authenticated, transport-neutral operator API. Discord owns conversation, threads, buttons, and presentation. Factory Floor remains authoritative for commands, run state, approvals, cancellation, events, and artifacts.

## Control-plane configuration

Factory Floor already requires distinct bearer tokens:

```dotenv
CONTROL_PLANE_OPERATOR_TOKEN=replace-with-a-long-random-operator-token
CONTROL_PLANE_ADMIN_TOKEN=replace-with-a-different-long-random-admin-token
```

Give Discord Agent only the operator token. Do not copy the admin token to the Discord host.

The control plane should remain bound to a private interface or localhost behind a private tunnel. The operator token authorizes:

- read-only inspection endpoints under `GET /api/v1/inspect/*`;
- all methods under `/api/v1/operator/*`.

Registration, system application, generic command submission, projection rebuild, and other mutation namespaces remain admin-only.

## Audit headers

Every operator request must include:

```http
Authorization: Bearer <operator token>
X-Factory-Floor-Principal-Id: discord:<discord user id>
X-Factory-Floor-Adapter: discord-agent
```

The principal ID is written into durable task, approval, and cancellation audit records. The adapter header is optional but recommended.

## Operator endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/operator/status` | Factory health and active-work summary |
| `POST` | `/api/v1/operator/tasks` | Submit a development task |
| `GET` | `/api/v1/operator/runs/:runId` | Read canonical run status |
| `GET` | `/api/v1/operator/runs/:runId/trace` | Read the bounded durable run trace |
| `GET` | `/api/v1/operator/runs/:runId/artifacts` | List artifacts produced by the run |
| `GET` | `/api/v1/operator/artifacts/:artifactId` | Read bounded textual artifact content |
| `GET` | `/api/v1/operator/approvals` | List pending approvals |
| `POST` | `/api/v1/operator/approvals/:approvalId/decision` | Approve or reject a pending action |
| `POST` | `/api/v1/operator/runs/:runId/cancel` | Cancel only the selected run graph |

List endpoints accept `limit` and opaque `cursor` query parameters. Artifact reads accept `maxBytes`, bounded by the runtime to 1 MiB.

## Task submission

```json
{
  "clientRequestId": "discord-message-or-interaction-id",
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
    "discordGuildId": "...",
    "discordChannelId": "...",
    "discordThreadId": "...",
    "discordMessageId": "..."
  }
}
```

The canonical command ID returned as `runId` is the durable identity Discord must persist. Reusing the same principal and `clientRequestId` replays the original submission instead of creating duplicate work.

Factory Floor deliberately refuses merge authority at this boundary. A later, explicit user action may merge through a separately authorized workflow.

## Approval decisions

```json
{
  "clientRequestId": "discord-interaction-id",
  "decision": "approve",
  "reason": "Approved by the repository owner in the bound Discord thread."
}
```

Equivalent retries are idempotent. A reused request ID with different content, a stale decision, or a decision against a different approval returns `409 Conflict`.

## Cancellation

```json
{
  "clientRequestId": "discord-interaction-id",
  "reason": "Cancelled by the repository owner in Discord."
}
```

Cancellation is scoped to the selected run correlation. It does not cancel unrelated work in the same region, and stale worker results are fenced after cancellation.

## Discord persistence boundary

Discord Agent should persist only the binding needed to recover presentation after restart:

- Factory Floor run ID;
- project name;
- guild, channel, thread, and initiating message IDs;
- initiating user ID;
- last rendered state and last successful refresh time.

Factory Floor remains the source of truth. On restart, Discord Agent should re-read run status rather than infer completion from its local SQLite state.

## Polling and interaction behavior

Until a push or event-stream bridge is added, poll active runs at a modest interval and stop polling terminal runs. Refresh immediately after an approval or cancellation action.

Recommended presentation:

- one Discord thread per Factory Floor run;
- a single edited status card rather than repeated telemetry messages;
- buttons for refresh, cancel, approve, and reject when applicable;
- concise completion summaries with links to produced pull requests or artifacts;
- no automatic merge button.
