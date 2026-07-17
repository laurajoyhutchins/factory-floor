# Operator Core Salvage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PR #26's Custom GPT Actions bridge with transport-neutral, correctly scoped operator command and query services.

**Architecture:** Treat the submitted command ID as the durable run ID. Split mutations from projections, relate run data through `deliveries.source_command_id`, and cancel only the delivery/execution/attempt graph belonging to that command.

**Tech Stack:** TypeScript, Kysely, PostgreSQL, Vitest, pnpm.

## Global Constraints

- Preserve the control plane as the sole authority over durable state.
- Do not retain ChatGPT-specific names in runtime records or contracts.
- Do not cancel unrelated work in the same region.
- Approval and cancellation requests must be idempotent and auditable.
- Existing populated databases must migrate successfully.

---

### Task 1: Add failing integration coverage for neutral run semantics

**Files:**
- Create: `tests/integration/runtime-core/operator-service.test.ts`

**Interfaces:**
- Consumes: existing `CommandService`, `WorkerProtocolService`, registration, and policy services.
- Produces: expected behavior for `OperatorCommandService` and `OperatorQueryService`.

- [ ] Write tests asserting that submission returns `commandId` as `runId`, status derives delivery/execution counts, artifact listing is run-scoped, cancellation affects only the selected command graph, and stale leased attempts cannot submit after cancellation.
- [ ] Run `pnpm test:integration -- tests/integration/runtime-core/operator-service.test.ts` and confirm failures because the neutral services do not exist.

### Task 2: Add production-safe approval audit migration

**Files:**
- Modify: `packages/db/src/database.ts`
- Create: `packages/db/src/migrations/012_operator_decision_audit.ts`

**Interfaces:**
- Produces nullable `decision_reason`, `decision_client_request_id`, and `decision_request_digest` approval fields with terminal-state consistency.

- [ ] Add a migration test expectation through the integration suite.
- [ ] Backfill existing terminal rows before adding the audit check constraint and idempotency index.
- [ ] Run the focused integration suite and confirm migration setup succeeds.

### Task 3: Implement focused operator command service

**Files:**
- Create: `packages/runtime-core/src/operator/operator-command-service.ts`
- Create: `packages/runtime-core/src/operator/errors.ts`

**Interfaces:**
- Produces: `submitDevelopmentTask`, `decideApproval`, and `cancelRun` using `OperatorContext`.

- [ ] Implement authorization and input validation.
- [ ] Submit development tasks through `CommandService` with neutral source metadata and command ID run identity.
- [ ] Record approvals transactionally with digest-based replay handling.
- [ ] Record cancellation idempotently and cancel only deliveries, executions, and attempts derived from the run command.
- [ ] Run the focused integration suite until mutation tests pass.

### Task 4: Implement focused operator query service

**Files:**
- Create: `packages/runtime-core/src/operator/operator-query-service.ts`
- Create: `packages/runtime-core/src/operator/types.ts`

**Interfaces:**
- Produces: factory status, run status, trace, run artifacts, bounded artifact reads, and pending approvals.

- [ ] Resolve a run by command ID and query its delivery/execution graph.
- [ ] Derive real queued, active, completed, failed, and cancelled counts.
- [ ] Filter artifacts through `execution_outputs` for executions belonging to the run.
- [ ] Keep artifact content bounded and limited to committed textual artifacts.
- [ ] Run the focused integration suite until projection tests pass.

### Task 5: Export the neutral services and remove legacy transport

**Files:**
- Modify: `packages/runtime-core/src/index.ts`
- Delete from the replacement branch: all `chatgpt-actions` routes, OpenAPI files, generated ChatGPT contracts, environment variables, and validation hooks introduced by PR #26.

**Interfaces:**
- Produces: transport-neutral runtime exports only.

- [ ] Export the operator types, errors, command service, and query service.
- [ ] Confirm the diff against `main` contains no `CHATGPT_ACTIONS_` or `chatgpt-actions` references outside historical design text.
- [ ] Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:integration`.

### Task 6: Replace PR #26 branch and verify CI

**Files:**
- Update PR title and description.

**Interfaces:**
- Produces: a clean PR based on current `main` containing only the salvaged operator core.

- [ ] Move `codex/implement-chatgpt-integration-for-factory-floor` to the verified replacement commit.
- [ ] Update PR #26 title/body to describe the neutral operator services.
- [ ] Confirm the PR is mergeable and Repository Verification completes successfully.
