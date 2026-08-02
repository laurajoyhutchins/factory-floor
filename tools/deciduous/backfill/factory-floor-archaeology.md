# Factory Floor Deciduous archaeology backfill

**Status:** reviewable archaeology snapshot  
**Prepared:** 2026-08-02  
**Scope:** `laurajoyhutchins/factory-floor` through the current `main` branch  
**Graph:** `.deciduous/exports/factory-floor-archaeology.json`

## Purpose

This backfill maps the consequential design evolution of Factory Floor into a Deciduous decision graph. It is an alternative interface to repository history, not a replacement for that history.

Authority remains unchanged:

- GitHub issues define proposed work and acceptance criteria.
- ADRs and normative repository documentation define accepted architecture.
- Pull requests and commits define implemented changes and verification.
- Deciduous records goals, design choices, observations, pivots, actions, and outcomes.

When this graph disagrees with an authoritative source, the authoritative source wins.

## Method

The backfill follows the Deciduous skills shipped in
`notactuallytreyanastasio/deciduous` at source revision
`1bb5a1595011943973716f316d65cd03944feadd`:

- `.opencode/skills/pulse/SKILL.md`: map the current behavioral model before reconstructing history;
- `.opencode/skills/narratives/SKILL.md`: treat coherent narratives as the source of truth and commits as evidence;
- `.opencode/skills/archaeology/SKILL.md`: turn narratives and pivots into a queryable graph without creating a node for every commit;
- `.claude/commands/decision-graph.md`: ground every node in repository evidence, preserve temporal direction, and connect actions and observations to sources.

The working sequence was:

1. Read the current Deciduous pilot policy and design in Factory Floor.
2. Identify the system's current behavioral boundaries.
3. Review the complete feature-level commit arc and search separately for removals, replacements, salvage work, deprecations, and refactors.
4. Read key pull-request bodies and active milestone issues for rationale that commit subjects alone do not preserve.
5. Consolidate evidence into seven narratives.
6. Build a forward-flowing DAG, adding cross-narrative edges only where one design boundary demonstrably enabled or constrained another.
7. Validate the exported JSON structure, canonical node and edge types, endpoint integrity, and acyclicity.

Routine edits, formatting changes, repeated verification runs, and unsupported explanations were intentionally omitted.

## Narrative 1: Durable control-plane authority and recovery

> Factory Floor keeps runtime truth in a durable control plane while language-neutral workers claim immutable work and propose results.

**Current state:** Runtime contracts are language-neutral. PostgreSQL stores authoritative lifecycle state. TypeScript and Python workers operate through the same fenced protocol. Result publication is atomic, and restart recovery reconciles uncertain handoffs rather than blindly repeating them.

**Evolution:**

1. Language-neutral contracts established a boundary that was not owned by one implementation language.
2. Durable PostgreSQL state made command, event, topology, execution, attempt, and delivery identity recoverable.
3. Worker HTTP protocol v1 defined immutable claims, capability checks, heartbeats, cancellation fencing, artifact staging, and proposed-result handoff.
4. The control plane became the only component allowed to atomically publish proposed results.
5. **PIVOT:** Atomic commit was not sufficient at provider and crash boundaries. Lost responses and post-handoff crashes could make completed work appear uncertain.
6. Startup recovery added reconciliation keyed by durable identity before retry or abandonment.

**Evidence:**

- `393c2f7`: language-neutral runtime contracts.
- `06815d9`: durable runtime database.
- `c2b20e1`: Worker HTTP protocol v1.
- `17fe852`, `119fb11`: TypeScript and Python worker SDKs.
- `9dbfbf6`: atomic execution-result commit.
- `c35b4cb`: durable cross-language investigation with retry and fan-in.
- `ae6e632`: indeterminate external-action reconciliation.
- `c9d1cba`: durable worker-result handoff recovery.

**Connects to:** artifact integrity, operator boundaries, repository-task execution, and verification.

## Narrative 2: Artifact integrity

> Artifact identity is controlled by immutable metadata and content digests rather than by a storage backend.

**Current state:** A conformance-tested `ArtifactBlobStore` boundary supports filesystem and S3-compatible adapters. Bytes are staged and promoted idempotently, metadata is published transactionally, and reconciliation treats uncertain physical objects conservatively.

**Evolution:**

1. The blob-store interface separated runtime identity rules from physical storage.
2. Filesystem and MinIO-compatible S3 adapters implemented the same digest, size, conditional-promotion, pagination, and idempotency behavior.
3. Metadata publication, tombstoning, resumable reconciliation, and orphan cleanup were added as explicit runtime services.
4. Atomic execution commit validates staged bytes and can preserve failed-attempt evidence without redefining artifact identity.

**Evidence:**

- `5457518`: blob-store interface and filesystem adapter.
- `a46e4e3`: S3-compatible adapter.
- `c5144a2`: publication and reconciliation.
- `9dbfbf6`: commit-time artifact validation.

**Connects to:** durable execution, template initial state, and repository-task evidence retention.

## Narrative 3: Operator boundary evolution

> Operators use reusable, run-scoped services and views while host adapters remain outside runtime authority.

**Current state:** Transport-neutral command and query services expose bounded run operations through an authenticated HTTP API. A reusable client and React UI serve both the standalone console and a Discord Activity adapter with immutable run-bound sessions.

**Evolution:**

1. A desktop-first read-only console proved the inspection model without introducing mutation.
2. **PIVOT:** The original Custom GPT Actions implementation coupled durable operator semantics to one transport, its routes, OpenAPI, bearer configuration, and naming.
3. The durable semantics were salvaged as transport-neutral command and query services, and the legacy transport surface was removed.
4. An authenticated operator HTTP API exposed the neutral services.
5. Reusable client and UI packages separated run-scoped product behavior from host integration.
6. Discord Activity became a host adapter with directional authentication, replay protection, immutable bindings, and a disabled-by-default embedded shell.
7. Run-isolated detail queries completed the shared standalone and embedded model.

**Evidence:**

- `9eec83f`: read-only operator console.
- PR #26 / `13a1087`: transport-neutral operator services and explicit removal of Custom GPT Actions coupling.
- `0b85fb2`: authenticated operator API.
- `2fadb99`: reusable operator client and UI packages.
- `e19ced4`, `f233cc0`, `0f19853`: Discord adapter, embedded shell, and run-isolated details.

**Connects to:** durable authority and generic template inspection.

## Narrative 4: Static systems to generic template instantiation

> Reusable systems are instantiated from immutable definitions into eligible regions without hard-coded topology names.

**Current state:** Template instantiation resolves immutable definitions, validates boundary contracts and effective topology before writes, publishes topology and initial state atomically, persists append-only history, and exposes operator-safe inspection.

**Evolution:**

1. Immutable static-system declarations introduced canonical identity and transactional topology application.
2. **PIVOT:** The accepted path still assumed an investigation-specific region and could not serve arbitrary eligible targets.
3. Generic template instantiation retained strict validation and atomic publication while removing the literal `investigation` requirement.
4. Versioned language-neutral contracts, durable instantiation history, initial-state artifacts, and inspection made the generic model externally stable and recoverable.
5. The next active design question is bounded dynamic child-region construction with parent-bounded authority and resources.

**Evidence:**

- `68af1ab`: static system registration and application.
- PR #54 / `b167bc2`: generic template instantiation and removal of investigation-specific assumptions.
- `8b71d0a`: template-instantiation protocol.
- `b587566`: durable history.
- `4a07da1`: initial-state publication.
- `9526812`: operator inspection.
- Issue #35: bounded dynamic regions and delegated authority.

**Connects to:** durable authority, artifact lineage, operator inspection, and future dynamic execution.

## Narrative 5: Repository-task automation

> Repository changes are compiled, applied, verified, and retained as bounded artifacts rather than executed by a privileged free-form worker.

**Current state:** Closed plan and recipe contracts compile into deterministic generation graphs. A bounded recipe proposes structured TypeScript changes. Accepted graphs are applied in isolation and verified through repository-owned commands. The complete workflow runs through Factory Floor's supported worker and artifact boundaries.

**Evolution:**

1. Closed plan and recipe contracts defined deterministic normalization and authority boundaries.
2. Authored Markdown plans compiled into canonical, digest-checked generation graphs.
3. The first deterministic recipe created or extended a TypeScript module, its Vitest contract, and exports.
4. Graph application moved into an isolated workspace with immutable-base checks and trusted verification profiles.
5. The workflow was integrated as a bounded durable worker, retaining graph, patch, verification, retry, cancellation, restart, and identity-mismatch evidence.
6. No worker receives GitHub credentials or performs an unmediated external write.

**Evidence:**

- `8d6e955`: plan and recipe contracts.
- `6d51b33`: deterministic generation-graph compiler.
- `aa5b510`: TypeScript module recipe.
- `a3d8bb2`: isolated application and verification.
- PR #137 / `6f9a4ec`: bounded durable repository-task worker.

**Connects to:** durable execution, artifact evidence, verification, and external-action reconciliation.

## Narrative 6: Verification and production headless execution

> The repository owns one reproducible path from clean checkout to exact-head, restart, browser, and production-headless evidence.

**Current state:** A canonical polyglot bootstrap installs locked JavaScript and Python projects. Repository Verification consolidates trusted exact-head state, while privileged handoff remains separate. Compiled control-plane and worker entrypoints expose readiness, shutdown, lifecycle fencing, and restart acceptance.

**Evolution:**

1. A shared bootstrap replaced compensating per-workflow setup.
2. Production headless entrypoints made the supported deployment path explicit and fail-closed.
3. Trusted pull-request event, exact-head, and review-clearance state was consolidated without merging privileged handoff into ordinary verification.
4. Clean-checkout, service integration, restart, browser smoke, and retained evidence became recurring acceptance gates.

**Evidence:**

- `77d046e`: canonical polyglot bootstrap.
- `48d2e98`: production headless entrypoints.
- `bf0545c`: trusted pull-request state consolidation.
- PR #58 and PR #137 exact-head verification records.

**Connects to:** every runtime narrative and the Deciduous pilot itself.

## Narrative 7: Deciduous pilot and archaeology backfill

> Deciduous preserves consequential reasoning without becoming a second issue tracker, ADR system, runtime graph, or mandatory CI dependency.

**Current state:** Factory Floor pins Deciduous 0.16.0 behind a repository-owned nonblocking wrapper. Local SQLite state is ignored; useful full-graph JSON snapshots may be reviewed and committed.

**Evolution:**

1. Issue #57 defined a local-first, optional pilot and explicit authority boundaries.
2. PR #58 added the wrapper, policy, version pin, tests, export path, and rollback instructions.
3. **PIVOT:** Source and binary verification showed that the released CLI does not expose the `diff export` command still described in some documentation.
4. The wrapper switched to the supported `deciduous graph` output, validates JSON, and atomically publishes full snapshots.
5. This backfill applies the upstream pulse, narratives, archaeology, and graph-construction skills to Factory Floor's own evidence.

**Evidence:**

- Issue #57: pilot scope and evaluation.
- PR #58 / merge `a26b83c`: implementation and real-binary smoke test.
- `tools/deciduous/README.md` and `tools/deciduous/pilot-design.md`.
- Upstream Deciduous skill files at `1bb5a1595011943973716f316d65cd03944feadd`.

**Connects to:** all six product and engineering narratives above.

## Graph validation

The committed snapshot contains:

- 52 nodes;
- 52 directed edges;
- 7 root narrative goals;
- canonical Deciduous node types: `goal`, `decision`, `option`, `action`, `outcome`, `observation`, and `revisit`;
- canonical statuses and edge types only;
- stable `change_id` values;
- commit references embedded in implementation action titles and a detailed evidence ledger;
- no dangling edge endpoints;
- no directed cycles.

The graph is intentionally selective. It captures the model and its pivots, not every merged pull request.

## Limitations and continuation

This commit does not add the local Deciduous SQLite database, enable its HTTP daemon, install assistant hooks, change Factory Floor runtime behavior, or alter CI requirements. The JSON snapshot is the durable review artifact permitted by the existing pilot.

Future agents should use the repository wrapper prospectively for substantial work:

```bash
bash scripts/deciduous-pilot.sh recover
bash scripts/deciduous-pilot.sh start "<goal>"
bash scripts/deciduous-pilot.sh decision "<choice>" "<rationale>"
bash scripts/deciduous-pilot.sh observe "<discovery>"
bash scripts/deciduous-pilot.sh finish "<verified outcome>" HEAD
bash scripts/deciduous-pilot.sh export "<reviewable-name>.json"
```

Only export histories that improve recovery, review, or design continuity. Issue #57 remains the authority for the trial's success criteria and exit decision.
