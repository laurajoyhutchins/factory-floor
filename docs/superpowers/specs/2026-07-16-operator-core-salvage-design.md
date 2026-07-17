# Operator Core Salvage Design

## Purpose

Salvage the durable approval, cancellation, task-submission, inspection, and artifact-access work from PR #26 without retaining the legacy Custom GPT Actions transport. The result is a transport-neutral operator application boundary that can be called by the existing console, a future ChatGPT Apps SDK MCP adapter, a CLI, or another authenticated client.

## Architecture

The runtime owns two focused services:

- `OperatorCommandService` performs state-changing operator actions: submit a development task, record an approval decision, and cancel one submitted run.
- `OperatorQueryService` exposes bounded status, trace, approval, and artifact projections for one operator-visible run.

A submitted operator run is identified by the canonical command ID returned by `CommandService.submit`. Deliveries and executions are discovered through `deliveries.source_command_id`; artifacts are discovered through `execution_outputs` for those executions. No operator service imports HTTP, ChatGPT, or Apps SDK concepts.

## Durable semantics

Approval decisions are attributed to the operator principal and record a reason, client request ID, and canonical request digest. Equivalent replays return the original decision; conflicting or stale decisions fail. The approval and any linked external action are updated in one transaction.

Cancellation is scoped to deliveries and executions derived from the run command. It records an idempotent operator cancellation command, marks nonterminal deliveries, executions, and attempts cancelled, clears active leases, and preserves events and artifacts. It does not advance the containing region lifecycle epoch or cancel unrelated work in the region.

## Data and migrations

The approvals table gains nullable audit columns for decision reason, request ID, and digest. Existing terminal decisions are backfilled with explicit legacy values before adding the consistency constraint, so upgrades of populated databases remain valid. New decisions must satisfy the audit constraint.

## Transport boundary

PR #26 removes the Custom GPT Actions route, bearer-token configuration, OpenAPI document, and custom-GPT instructions. A later `apps/chatgpt` package will expose Apps SDK/MCP tools and call these neutral runtime services through a generic authenticated operator API.

## Testing

Integration tests prove command-ID run identity, run-scoped artifact queries, derived status counts, idempotent approval decisions, conflicting decisions, run-scoped cancellation, and rejection of stale worker results. Unit tests cover validation and authorization where database integration is not required.
