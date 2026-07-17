# Operator Core Salvage Design

## Purpose

Salvage the durable approval, cancellation, task-submission, inspection, and artifact-access work from PR #26 without retaining the legacy Custom GPT Actions transport. The result is a transport-neutral operator application boundary that can be called by the existing console, a future ChatGPT Apps SDK MCP adapter, a CLI, or another authenticated client.

## Architecture

The runtime owns two focused services:

- `OperatorCommandService` performs state-changing operator actions: submit a development task, record an approval decision, and cancel one submitted run.
- `OperatorQueryService` exposes bounded status, trace, approval, and artifact projections for one operator-visible run.

A submitted operator run is identified by the canonical command ID returned by `CommandService.submit`. That command ID is also the default correlation ID, so the run graph includes the command's initial deliveries and any downstream deliveries, executions, attempts, events, and artifacts carrying the same durable correlation. Artifacts are discovered through `execution_outputs` for executions in that graph. No operator service imports HTTP, ChatGPT, or Apps SDK concepts.

## Durable semantics

Approval decisions are attributed to the operator principal and record a reason, client request ID, and canonical request digest. Equivalent replays return the original decision; conflicting or stale decisions fail. The approval and every linked external action are updated in one transaction.

Cancellation is scoped to the run's durable correlation graph. It records an idempotent operator cancellation command, marks nonterminal deliveries and attempts cancelled, terminates active executions with an explicit `operator_cancelled` failure, clears active leases, and preserves events and artifacts. Query projections report those terminal execution failures as cancellation rather than operational failure. Cancellation does not advance the containing region lifecycle epoch or affect unrelated work in the region.

## Data and migrations

The approvals table gains nullable audit columns for decision reason, request ID, and digest. Existing terminal decisions are backfilled with explicit legacy values before adding the consistency constraint, so upgrades of populated databases remain valid. New decisions must satisfy the audit constraint.

## Transport boundary

PR #26 removes the Custom GPT Actions route, bearer-token configuration, OpenAPI document, and custom-GPT instructions. A later `apps/chatgpt` package will expose Apps SDK/MCP tools and call these neutral runtime services through a generic authenticated operator API.

## Testing

Integration tests prove command-ID run identity, run-scoped artifact queries, derived status counts, idempotent approval decisions, conflicting decisions, run-scoped cancellation, and rejection of stale worker results. Unit tests cover validation and authorization where database integration is not required.
