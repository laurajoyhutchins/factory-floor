# Template Instantiation Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose durable template-instantiation history and initial-state provenance through one operator-safe read model consumed by inspection APIs, run-scoped operator APIs, CLI commands, traces, artifact lineage, and the read-only console.

**Architecture:** Add a focused `TemplateInstantiationInspectionService` that reads the authoritative `template_instantiations`, topology, template, component-state, schema, and artifact tables without creating a second materialized history. `ObservabilityService` and `OperatorQueryService` delegate to this service. Pagination uses a scope-bound composite cursor, and existing projection rebuild records a lightweight derived snapshot named `template-instantiation-history`.

**Tech Stack:** TypeScript, Kysely, PostgreSQL, Fastify, Vitest, React 19, TanStack Query, Vite.

## Global Constraints

- Preserve append-only authoritative history; do not create a duplicate materialized instantiation table.
- List queries must be bounded, deterministic, and scoped by exactly one of `regionId` or `runId`.
- Cursors must bind to the normalized scope and order by `(created_at, id)`.
- Opaque JSON fields remain opaque JSON; never expose raw database rows, credentials, or internal storage locators.
- CLI and console must consume supported HTTP inspection/operator boundaries only.
- Follow test-first development and exact-head Repository Verification before merge.

---

### Task 1: Canonical inspection read model

**Files:**

- Create: `packages/runtime-core/src/inspection/template-instantiation-inspection-service.ts`
- Modify: `packages/runtime-core/src/index.ts`
- Test: `tests/integration/runtime-core/template-instantiation-inspection.test.ts`

**Interfaces:**

- Produces `TemplateInstantiationInspectionService`.
- Produces `list({ regionId } | { runId }, page)` returning `{ items, nextCursor }`.
- Produces `get(instantiationId)` returning an operator-safe detail or `null`.
- Produces `listForTopologyRevision(topologyRevisionId)` for trace relationships.
- Produces `forArtifact(artifactId)` for state-artifact lineage relationships.

- [ ] **Step 1: Write the failing PostgreSQL integration tests**

Cover region-scoped deterministic pagination, run-scoped isolation, malformed or cross-scope cursor rejection, complete detail shape, initial-state owner/schema/artifact/value provenance, restart-visible reads from a fresh service instance, and absence of internal storage locators.

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run tests/integration/runtime-core/template-instantiation-inspection.test.ts`

Expected: failure because `TemplateInstantiationInspectionService` is not exported.

- [ ] **Step 3: Implement the minimal canonical service**

Use a versioned base64url JSON cursor:

```ts
type Cursor = {
  v: 1;
  scopeDigest: string;
  afterCreatedAt: string;
  afterId: string;
};
```

Return stable camelCase read models. Detail must contain request/effective identity, target region, topology revision, source template, parameters, configuration overrides, causal source, referenced definitions, disposition, timestamp, and an `initialStates` array with component owner, state port, schema identity, artifact identity, inline payload, state version, and provenance.

- [ ] **Step 4: Verify GREEN**

Run the focused integration test and the runtime-core unit suite.

- [ ] **Step 5: Commit**

Commit message: `feat(runtime): add template instantiation inspection model`

### Task 2: Supported API, projection, trace, lineage, and CLI boundaries

**Files:**

- Modify: `packages/runtime-core/src/observability/observability-service.ts`
- Modify: `packages/runtime-core/src/operator/operator-query-service.ts`
- Modify: `apps/control-plane/src/inspection-routes.ts`
- Modify: `apps/control-plane/src/operator-routes.ts`
- Modify: `apps/cli/src/index.ts`
- Test: `packages/runtime-core/test/observability-service.test.ts` or a new focused test file if the existing file name differs
- Test: `apps/control-plane/test/inspection-routes.test.ts` or a new focused route test
- Test: `apps/cli/test/cli.test.ts` or a new focused CLI test

**Interfaces:**

- `GET /api/v1/inspect/instantiations?regionId=<uuid>&cursor=<cursor>&limit=<n>`
- `GET /api/v1/inspect/instantiations?runId=<uuid>&cursor=<cursor>&limit=<n>`
- `GET /api/v1/inspect/instantiations/:id`
- `GET /api/v1/operator/runs/:runId/instantiations`
- `ff inspect instantiations [id] --region-id <uuid> | --run-id <uuid>`

- [ ] **Step 1: Write failing route, projection, trace/lineage, and CLI tests**

Assert stable 400/404 behavior, pagination forwarding, operator authorization, the new `template-instantiation-history` projection snapshot, execution-trace topology relationships, state-artifact lineage relationships, and CLI URL construction.

- [ ] **Step 2: Verify RED**

Run the focused tests; expected failures are missing methods and routes.

- [ ] **Step 3: Implement thin delegation**

Add `template-instantiation-history` to `PROJECTION_NAMES`. Its snapshot reports instantiation count, seeded-state count, first timestamp, and latest timestamp. Extend execution trace with `templateInstantiations`, artifact lineage with `templateInstantiations`, and operator run queries with the canonical service output.

- [ ] **Step 4: Verify GREEN**

Run focused tests plus canonical unit verification.

- [ ] **Step 5: Commit**

Commit message: `feat(operator): expose template instantiation inspection`

### Task 3: Read-only console and recovery acceptance

**Files:**

- Modify: `apps/console/src/api/client.ts`
- Modify: `apps/console/src/main.tsx`
- Modify: `apps/console/src/components/ui.tsx`
- Modify: `apps/console/src/pages/pages.tsx`
- Modify: `apps/console/src/styles.css` only if existing layout primitives are insufficient
- Test: `apps/console/src/pages/pages.test.tsx` or a new focused page test
- Test: `tests/integration/runtime-core/template-instantiation-inspection.test.ts`
- Modify: `docs/reference/template-instantiation-protocol-v1.md`

**Interfaces:**

- Console route `/instantiations` lists region-scoped history and links to `/instantiations/:instantiationId`.
- The detail page renders textual provenance and initial-state ownership/schema/artifact/value identity.

- [ ] **Step 1: Write failing console and recovery tests**

Cover loading, empty, stale-refresh, disconnected/error, accessible region selection, deterministic list order, detail not-found, textual provenance, fresh-process reads, and projection rebuild preserving the visible snapshot.

- [ ] **Step 2: Verify RED**

Run the focused console and integration tests.

- [ ] **Step 3: Implement the console pages and documentation**

Use existing `State`, `DataTable`, `JsonBlock`, `LoadMore`, `CopyId`, and `Timestamp` primitives. Keep the surface read-only and provide a complete text alternative independent of graph rendering.

- [ ] **Step 4: Verify GREEN and exact head**

Run `pnpm verify:static`, `pnpm verify:unit`, integration verification, live restart, and Milestone 1 clean acceptance through Repository Verification.

- [ ] **Step 5: Final review and merge**

Update the PR body with exact-head evidence, post the required owner-authored review-clearance comment, confirm `verify` and `review / cleared`, then squash merge with the expected head SHA.
