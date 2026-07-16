# Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the current code-review findings around control-plane authentication, scheduler fairness, lease coherence, artifact validation transaction length, lossless inspection rendering, worker authorization, and bounded startup recovery.

**Architecture:** Keep authority in the control plane. Add explicit operator/admin authentication at the HTTP boundary, select runnable work groups rather than a single oldest delivery, treat attempt and delivery leases as one invariant, validate immutable staged bytes before the short publication transaction, preserve opaque JSON in the console, authorize worker selectors server-side, and bound startup recovery work before readiness.

**Tech Stack:** TypeScript, Fastify, Kysely/PostgreSQL, Vitest, React/Vite, AJV, existing ArtifactBlobStore adapters.

## Global Constraints

- Preserve the Worker HTTP protocol v1 compatibility surface unless a security correction requires a documented additive field.
- Keep PostgreSQL private to the control plane.
- All new HTTP mutation paths require admin authentication.
- Inspection GET paths require operator or admin authentication.
- Worker authentication remains separate from operator/admin authentication.
- Add regression coverage before implementation changes.
- Keep startup and reconciliation work bounded.

---

### Task 1: Control-plane authentication and route separation

**Files:**
- Create: `apps/control-plane/src/security.ts`
- Modify: `apps/control-plane/src/app.ts`
- Modify: `apps/control-plane/src/server.ts`
- Modify: `apps/control-plane/src/routes/inspection.ts`
- Modify: `.env.example`
- Test: `apps/control-plane/test/security.test.ts`

- [ ] Write tests proving health is public, inspection GET requires operator/admin credentials, admin mutations reject operator-only credentials, worker routes retain their separate bearer token, and the real server configuration fails closed without operator/admin tokens.
- [ ] Move projection rebuild to `/api/v1/admin/projections/rebuild`.
- [ ] Default the server host to `127.0.0.1` and require both tokens for actual server startup.
- [ ] Run focused control-plane tests.

### Task 2: Scheduler fairness

**Files:**
- Modify: `packages/runtime-core/src/scheduling/scheduler-service.ts`
- Test: `tests/integration/runtime-core/command-scheduler.test.ts`

- [ ] Add a failing integration test with an incomplete older group and a complete younger group.
- [ ] Select a bounded ordered set of candidate groups and continue past incomplete, contended, or already-active groups.
- [ ] Add coverage for lock contention and unrelated runnable work.
- [ ] Run the scheduler integration suite.

### Task 3: Coherent attempt and delivery leases

**Files:**
- Modify: `packages/runtime-core/src/worker/worker-protocol-service.ts`
- Modify: `packages/runtime-core/src/observability/recovery-service.ts`
- Test: `tests/integration/runtime-core/worker-protocol.test.ts`
- Test: `tests/integration/runtime-core/observability-recovery.test.ts`

- [ ] Add a failing heartbeat test asserting all input delivery expirations are renewed atomically with the attempt.
- [ ] Add a restart-recovery test where the original delivery expiry passed but the heartbeat-renewed attempt remains valid.
- [ ] Renew input deliveries in the heartbeat transaction.
- [ ] Release expired deliveries only when no still-valid active attempt owns them.
- [ ] Run focused worker/recovery integration tests.

### Task 4: Short artifact publication transactions

**Files:**
- Create: `packages/runtime-core/src/artifacts/artifact-validation-receipt-service.ts`
- Modify: `packages/runtime-core/src/artifacts/artifact-validation-service.ts`
- Modify: `packages/runtime-core/src/commit/execution-commit-service.ts`
- Modify: `packages/runtime-core/src/index.ts`
- Test: `tests/integration/runtime-core/atomic-commit.test.ts`

- [ ] Add a failing test proving blob reads complete before publication row locks are acquired and stale receipts are rejected.
- [ ] Validate immutable bytes and schema outside the publication transaction and create an in-memory receipt bound to staging id, digest, size, schema id, schema digest, and media type.
- [ ] Recheck the receipt-bound metadata inside the short transaction before publication.
- [ ] Cache compiled AJV validators by schema digest.
- [ ] Run atomic commit integration tests.

### Task 5: Lossless console adapters

**Files:**
- Modify: `apps/console/src/api/adapters.tsx`
- Modify: `apps/console/src/api/client.ts`
- Test: `apps/console/src/api/client.test.ts`

- [ ] Add a failing regression test with both `model_score` and `modelScore` in an opaque payload.
- [ ] Normalize only API-owned envelope keys and preserve provenance, payload, configuration, attributes, normalized inputs, modifications, and failure subtrees verbatim.
- [ ] Run console tests and production build.

### Task 6: Server-authorized worker selectors

**Files:**
- Modify: `packages/runtime-core/src/worker/worker-protocol-service.ts`
- Modify: `apps/control-plane/src/app.ts`
- Test: `tests/integration/runtime-core/worker-protocol.test.ts`

- [ ] Add a failing test proving a worker cannot claim an undelegated selector merely by advertising it.
- [ ] Add a worker authorization resolver keyed by authenticated worker id and intersect request selectors with the server-side allowlist.
- [ ] Preserve current demo behavior through explicit configured allowlists.
- [ ] Run worker protocol and end-to-end investigation tests.

### Task 7: Bounded startup recovery

**Files:**
- Modify: `packages/runtime-core/src/observability/recovery-service.ts`
- Modify: `apps/control-plane/src/app.ts`
- Test: `tests/integration/runtime-core/observability-recovery.test.ts`

- [ ] Add tests proving expired-attempt and cancelling-region passes honor configured limits and report continuation state.
- [ ] Bound the initial recovery pass and return explicit remaining-work flags/cursors.
- [ ] Keep startup safety fencing synchronous while deferring additional reconciliation/projection batches to subsequent bounded runs.
- [ ] Run recovery and live-restart acceptance tests.

### Task 8: Repository verification and publication

- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm test:integration`.
- [ ] Run `pnpm format:check`.
- [ ] Run `pnpm accept:m1`.
- [ ] Open a pull request with exact verification results and remaining limitations, if any.
