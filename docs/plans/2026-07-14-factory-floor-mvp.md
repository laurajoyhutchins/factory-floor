# Factory Floor MVP Implementation Plan

> **For agentic workers:** Execute this plan task-by-task. Track the checkbox state in this file. Use test-driven development and small conventional commits.

**Goal:** Build Milestone 1, a durable reactive graph that executes TypeScript and Python components, stages immutable artifacts, atomically commits successful results, survives failure and restart, and exposes a complete trace.

**Architecture:** A TypeScript transactional modular monolith uses PostgreSQL as the authoritative coordination store and an adapter-backed blob store for artifact bytes. Workers are separate processes that claim attempts through HTTP, receive immutable invocation envelopes, stage outputs, and propose results. Only the control plane validates and commits runtime truth.

**Stack:** Node.js 22, TypeScript 5.x, pnpm workspaces, Python 3.12, uv, Fastify, PostgreSQL 16, Kysely, Ajv 8, Pino, OpenTelemetry, Vitest, pytest, Docker Compose, local filesystem and S3-compatible artifact adapters.

## Global constraints

- JSON Schema Draft 2020-12 is authoritative.
- Workers have no PostgreSQL credentials and cannot write committed artifact namespaces.
- Every artifact is immutable and content-addressed by SHA-256.
- Command, event, delivery, execution, and attempt are distinct durable entities.
- Successful attempt effects become visible through one PostgreSQL transaction.
- Delivery is at-least-once; completion and dispatch paths must be idempotent.
- Stale lease tokens or lifecycle epochs cannot commit normal outputs.
- Failed attempts remain visible after retry.
- No work is silently deleted; terminal unresolved work is dead-lettered.
- Do not introduce Kafka, Temporal, Kubernetes operators, microservices, GraphQL, dynamic child regions, or a visual builder in Milestone 1.
- Do not start the operator console until the backend acceptance scenario passes.

## Normative repository map

```text
factory-floor/
├── apps/
│   ├── control-plane/          Fastify application and composition root
│   ├── cli/                    ff command-line client
│   └── console/                deferred until backend acceptance passes
├── contracts/
│   └── schemas/                authoritative JSON Schemas
├── packages/
│   ├── artifact-store/         blob staging, commit, reads, reconciliation
│   ├── contracts-ts/           generated TypeScript contract types
│   ├── contracts-py/           generated Python Pydantic models
│   ├── db/                     Kysely types, migrations, repositories
│   ├── runtime-core/           IDs, errors, lifecycle and commit services
│   ├── worker-sdk-ts/          TypeScript worker client and runner
│   └── worker-sdk-py/          Python worker client and runner
├── workers/
│   ├── demo-ts/                deterministic demo components
│   └── demo-py/                Python verification component
├── examples/
│   └── investigation/          fixtures, declarations and runner
├── infra/
│   └── docker/                 PostgreSQL and MinIO development services
├── tests/
│   ├── integration/            API, DB, restart and worker tests
│   └── conformance/            executable runtime invariants
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docker-compose.yml
└── .env.example
```

Modules may add focused files beneath these directories. Do not collapse repositories, protocol handlers, and domain services into single large files.

---

## Task 1: Initialize the monorepo and verification baseline

**Outcome:** The repository installs deterministically, starts PostgreSQL and MinIO, exposes a minimal Fastify health endpoint, and runs TypeScript and Python tests.

- [x] Create root `package.json` with `packageManager: pnpm@10.12.1`, Node `>=22 <23`, and scripts `lint`, `typecheck`, `test`, `test:integration`, `dev:services`, and `dev:control-plane`.
- [x] Create `pnpm-workspace.yaml`, `tsconfig.base.json`, ESLint flat config, Prettier config, and Vitest baseline.
- [x] Create the normative directories and package manifests.
- [x] Add `apps/control-plane/src/app.ts` exporting `buildApp()` and a `/health` route returning `{ status: "ok", service: "control-plane" }`.
- [x] Add a failing health test before implementation.
- [x] Initialize `packages/worker-sdk-py` as a uv project and add an import/version test.
- [x] Add Docker Compose services for PostgreSQL and MinIO.
- [x] Add `.env.example` using local-only development credentials and no real secrets.
- [x] Verify `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `uv run --project packages/worker-sdk-py pytest`.
- [x] Commit as `chore: initialize factory floor monorepo`.

## Task 2: Define language-neutral runtime contracts

**Outcome:** Canonical envelopes and artifact contracts validate in JSON Schema and generate deterministic TypeScript and Python types.

- [x] Write failing schema tests for an invocation envelope, proposed result, source identity, artifact descriptor, staged artifact, failure descriptor, external-action proposal, and resource usage.
- [x] Put canonical schemas under `contracts/schemas/` with `$schema: https://json-schema.org/draft/2020-12/schema`.
- [x] Use `additionalProperties: false` for protocol envelopes and explicit required arrays.
- [x] Model source identity as a discriminated union keyed by `kind`.
- [x] Require SHA-256 digests to match `^[a-f0-9]{64}$`.
- [x] Require `failure` when proposed result status is `failed` using JSON Schema `if`/`then`.
- [x] Add deterministic TypeScript generation using sorted schema paths and `json-schema-to-typescript`.
- [x] Add deterministic Python generation using `datamodel-code-generator` with Pydantic v2 output.
- [x] Commit generated TypeScript and Python outputs.
- [x] Verify a second generation produces no diff.
- [x] Commit as `feat: define language-neutral runtime contracts`.

## Task 3: Create the PostgreSQL schema and repository boundary

**Outcome:** Migrations create the normative durable model, and repository methods compose under a shared Kysely transaction.

- [x] Write a migration test against an isolated PostgreSQL database.
- [x] Create Kysely database types and `createDatabase(connectionString)`.
- [x] Add the initial migration for definitions, schemas, regions, topology revisions, component instances, connections, commands, events, deliveries, executions, attempts, execution inputs/outputs, artifacts, derivations, staging, capabilities, grants, policy decisions, approvals, external actions, resource ledger, and projection checkpoints.
- [x] Add required uniqueness, foreign keys, check constraints, lease indexes, and ready-delivery indexes.
- [x] Enforce exactly one delivery source: command or event.
- [x] Enforce unique `(execution_id, attempt_number)` and artifact digest identity rules.
- [x] Create focused repositories whose methods accept `Kysely<Database> | Transaction<Database>`.
- [x] Add migration CLI and reset helpers restricted to tests/development.
- [x] Verify migration up/down or clean-database recreation behavior.
- [x] Commit as `feat: add durable runtime database`.

## Task 4: Implement immutable artifact staging and reconciliation

**Outcome:** Workers can stage bytes, while only the control plane can validate and publish immutable artifact metadata.

- [x] Define the `ArtifactBlobStore` interface with stage, read-staged, promote, read-committed, remove-staged, and existence checks.
- [x] Implement a filesystem adapter first.
- [ ] Implement an S3-compatible adapter against MinIO.
- [x] Compute SHA-256 while streaming and verify claimed digest and size.
- [x] Store staged locators separately from committed locators.
- [ ] Add schema validation by artifact schema identity before commit.
- [x] Make promotion idempotent.
- [ ] Add reconciliation for staged bytes without metadata and committed metadata whose bytes have not promoted.
- [ ] Preserve artifact identity and provenance when content is tombstoned.
- [ ] Test duplicate staging, digest mismatch, interrupted promotion, and reconciliation.
- [ ] Commit as `feat: add immutable artifact storage`.

## Task 5: Add registration, system application, and static topology

**Outcome:** Schemas, component definitions, templates, and the Milestone 1 static investigation system can be registered and applied idempotently.

- [ ] Add immutable registration services and APIs for schemas, component definitions, templates, and policies.
- [ ] Make natural key plus digest registrations idempotent and reject conflicting content.
- [ ] Validate all declarations before interpretation.
- [ ] Implement static system application from `examples/investigation-system.yaml`.
- [ ] Create the root and stable regions, component instances, ports, connections, and topology revision transactionally.
- [ ] Ensure repeated application is a no-op or produces an explicit deterministic conflict, never silent mutation.
- [ ] Add CLI commands for schema/component registration and system application.
- [ ] Add integration tests for clean apply, repeated apply, invalid declaration, and conflicting registration.
- [ ] Commit as `feat: register and apply static systems`.

## Task 6: Implement commands, routing, deliveries, and execution creation

**Outcome:** An accepted command creates durable events/deliveries and schedules logical executions without an external broker.

- [ ] Add command submission with source, region, correlation ID, payload, expiry, and durable acceptance/rejection.
- [ ] Route accepted commands and events through the active topology revision.
- [ ] Create one delivery per target input and keep source identity explicit.
- [ ] Implement ready-delivery polling with `FOR UPDATE SKIP LOCKED`.
- [ ] Create or reuse the logical execution idempotently from delivery, component, topology revision, lifecycle epoch, and normalized input set.
- [ ] Create attempt 1 and lease it with owner, token, and expiration.
- [ ] Add scheduler and lease tests with competing pollers.
- [ ] Test duplicate routing and scheduler restart without duplicate logical executions.
- [ ] Commit as `feat: add durable delivery scheduler`.

## Task 7: Implement worker protocol and SDKs

**Outcome:** TypeScript and Python worker processes can claim, heartbeat, observe cancellation, stage artifacts, and submit proposed results through one protocol.

- [ ] Add separately authenticated `/worker/v1` endpoints.
- [ ] Implement claim, heartbeat, cancellation, artifact stage, staged-content upload, result submission, and capability invocation endpoints.
- [ ] Generate immutable invocation envelopes with short-lived artifact URLs and opaque capability handles.
- [ ] Reject inactive attempts, stale lease tokens, and stale lifecycle epochs.
- [ ] Build TypeScript and Python SDK clients and runners.
- [ ] Add deterministic demo worker components for retrieve, compare, verify, and synthesize.
- [ ] Implement `failFirstAttemptForDemo` in the Python verifier without mutating prior history.
- [ ] Test heartbeat extension, lease expiration, duplicate result submission, cancellation observation, and protocol compatibility across languages.
- [ ] Commit as `feat: add worker protocol and SDKs`.

## Task 8: Implement atomic execution commit and retry

**Outcome:** A valid proposed result publishes all runtime metadata atomically; failed attempts remain visible and retry safely.

- [ ] Write integration tests that fail if artifacts, events, resource entries, downstream deliveries, or terminal statuses become partially visible.
- [ ] Lock the execution, attempt, delivery, region, and component instance rows required for validation.
- [ ] Verify active lease token and current region lifecycle epoch.
- [ ] Validate declared output ports, artifact digests, artifact schemas, proposed events, state, and authority.
- [ ] In one transaction commit artifacts and derivations, execution outputs, events, downstream deliveries, state version, resource ledger, external-action proposals, and terminal attempt/execution/delivery status.
- [ ] Promote blobs after commit and reconcile promotion failure.
- [ ] Implement failed-attempt transaction preserving failure artifact, resource use, and staged partial artifacts.
- [ ] Apply retry policy by creating a new attempt under the same execution.
- [ ] Default retry to three attempts with backoff 1s, 5s, and 30s.
- [ ] Dead-letter terminal unresolved work instead of deleting it.
- [ ] Test duplicate completion, stale lease, stale epoch, schema-invalid output, undeclared port, promotion failure, and safe retry.
- [ ] Commit as `feat: atomically commit execution results`.

## Task 9: Complete the investigation vertical slice

**Outcome:** One command runs the static investigation graph end-to-end through TypeScript and Python workers.

- [ ] Add schemas and fixtures for objective, evidence, candidate claims, verification result, final result, evidence bundle, uncertainty report, and failure artifacts.
- [ ] Register deterministic retrieve, compare, verify, and synthesize component definitions.
- [ ] Apply `examples/investigation-system.yaml`.
- [ ] Submit one investigation command through the public API or CLI.
- [ ] Fan out three retrieval executions and fan in all expected evidence.
- [ ] Deliberately fail verifier attempt 1 and schedule a replacement attempt.
- [ ] Preserve attempt 1 and its failure artifact.
- [ ] Complete verification, synthesis, and publication outputs on the later attempt.
- [ ] Verify no duplicate committed outputs or downstream deliveries.
- [ ] Add a single command or script that runs the entire demonstration.
- [ ] Commit as `feat: run durable investigation example`.

## Task 10: Add trace, projections, recovery, and conformance tests

**Outcome:** Operators can reconstruct causation and the runtime recovers after restart without loss or duplication.

- [ ] Add rebuildable projections for region/component status, queue depth, retry/failure counts, resource usage, approvals, topology, artifact lineage, and execution timeline.
- [ ] Store projection checkpoints and expose staleness/checkpoint metadata.
- [ ] Implement region, event, execution, trace, artifact, and lineage inspection APIs.
- [ ] Implement the corresponding `ff` CLI views with human and JSON output.
- [ ] Add SSE projection/event summaries with resumable cursor semantics.
- [ ] On startup abandon expired attempts, expose retryable work, resume projections, reconcile blobs, resume cancellation, and emit a recovery summary.
- [ ] Add conformance tests for every invariant in the reference specification.
- [ ] Restart the control plane during an investigation and verify no lost work or duplicate committed outputs.
- [ ] Cancel a run, increment lifecycle epoch, and verify stale results cannot commit.
- [ ] Rebuild projections from history without dispatching workers or external actions.
- [ ] Commit as `feat: add trace and recovery semantics`.

## Task 11: Harden the developer experience and document evidence

**Outcome:** A new Codespace can reproduce the milestone and its acceptance evidence from documented commands.

- [ ] Ensure `pnpm install` and uv sync are deterministic.
- [ ] Add root commands for services, migrations, workers, demo, tests, and cleanup.
- [ ] Add health checks and dependency readiness waits to Docker Compose.
- [ ] Keep PostgreSQL and MinIO ports private by default outside local development.
- [ ] Add CI for lint, typecheck, unit tests, Python tests, integration tests, generation drift, and conformance tests.
- [ ] Document architecture boundaries and local troubleshooting.
- [ ] Record acceptance evidence in `docs/evidence/m1-durable-reactive-graph.md`.
- [ ] Commit as `docs: record milestone one acceptance evidence`.

---

## Verification before completion

Run and report at minimum:

```bash
pnpm lint
pnpm typecheck
pnpm test
uv run --project packages/worker-sdk-py pytest
pnpm test:integration
```

Also run the investigation example end-to-end and include evidence that:

- verifier attempt 1 failed;
- a later attempt succeeded;
- both attempts remain visible;
- partial and failure artifacts remain inspectable;
- committed artifacts have valid digests, schemas, and provenance;
- retry did not duplicate outputs or downstream delivery;
- resource entries are attributable;
- the trace reconstructs command, delivery, execution, attempt, artifact, and event causation;
- a control-plane restart does not lose or duplicate work;
- cancellation fences stale results;
- historical projection replay performs no external side effects.

Milestone 1 is complete only when these checks pass from a clean Codespace checkout.
