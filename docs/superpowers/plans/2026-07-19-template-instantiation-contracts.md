# Template Instantiation Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the generic template-instantiation boundary as versioned JSON Schema with generated TypeScript and Python bindings, then adapt the runtime service to accept and return the canonical contract without duplicating wire semantics.

**Architecture:** Three self-contained Draft 2020-12 schemas define request, result, and stable error envelopes. The runtime keeps topology publication in `TemplateInstantiationService`, but a focused contract adapter normalizes current in-process callers into the canonical request, validates the entire wire shape before database work, and converts the internal database rows into the canonical result. Existing static-system callers use the same adapter, while future `RegionRequest` consumers can submit the generated request directly.

**Tech Stack:** JSON Schema Draft 2020-12, AJV 8, json-schema-to-typescript, datamodel-code-generator/Pydantic v2, TypeScript 5.8, Vitest 3, pnpm 10, uv.

## Global Constraints

- Keep `factory-floor.dev/v1alpha1` declaration compatibility unchanged.
- Use contract protocol version `1.0`.
- Preserve atomic topology validation/publication and the current idempotent digest behavior.
- Do not add an HTTP endpoint, durable instantiation-history table, initial-state publication mechanism, or child-region lifecycle in this issue.
- Generated TypeScript and Python files must be produced by the existing `pnpm contracts:generate` pipeline and pass drift checks.
- Invalid canonical requests must fail before any database query or durable write.

---

### Task 1: Contract Conformance Tests

**Files:**

- Create: `scripts/template-instantiation-contracts.test.mjs`

**Interfaces:**

- Consumes: `contracts/schemas/template-instantiation-request.schema.json`, `template-instantiation-result.schema.json`, and `template-instantiation-error.schema.json`.
- Produces: executable fixtures defining the accepted request/result/error surface and rejected malformed variants.

- [ ] **Step 1: Write the failing schema conformance test**

Create a Vitest suite that loads all three schema files into one strict AJV 2020 instance with formats enabled. Validate:

```js
const systemRequest = {
  protocolVersion: '1.0',
  requestId: '019bb22e-58b0-7d87-8000-000000000001',
  targetRegionId: '019bb22e-58b0-7d87-8000-000000000002',
  template: { name: 'bounded-investigation', version: '1' },
  parameters: { mode: 'strict' },
  componentConfiguration: { verifier: { retries: 2 } },
  source: {
    kind: 'system',
    name: 'investigation-demo',
    version: '1',
    contentDigest: 'a'.repeat(64),
  },
};
```

Also validate a `regionRequest` source, a created result, an existing result, and a stable error. Assert rejection for an extra property, invalid digest, missing source, malformed UUID, unknown source kind, and unknown error code.

- [ ] **Step 2: Run the focused test and preserve the red state**

Run: `pnpm vitest run scripts/template-instantiation-contracts.test.mjs`

Expected: FAIL because the three contract schema files do not exist.

- [ ] **Step 3: Commit the red test**

```bash
git add scripts/template-instantiation-contracts.test.mjs
git commit -m "test(contracts): specify template instantiation boundary"
```

### Task 2: Canonical JSON Schemas and Generated Bindings

**Files:**

- Create: `contracts/schemas/template-instantiation-request.schema.json`
- Create: `contracts/schemas/template-instantiation-result.schema.json`
- Create: `contracts/schemas/template-instantiation-error.schema.json`
- Create: `packages/contracts-ts/src/generated/template-instantiation-request.ts`
- Create: `packages/contracts-ts/src/generated/template-instantiation-result.ts`
- Create: `packages/contracts-ts/src/generated/template-instantiation-error.ts`
- Modify: `packages/contracts-ts/src/index.ts`
- Create: `packages/contracts-py/factory_floor_contracts/template_instantiation_request_schema.py`
- Create: `packages/contracts-py/factory_floor_contracts/template_instantiation_result_schema.py`
- Create: `packages/contracts-py/factory_floor_contracts/template_instantiation_error_schema.py`
- Modify: `packages/contracts-py/factory_floor_contracts/__init__.py`

**Interfaces:**

- Produces: `TemplateInstantiationRequest`, `TemplateInstantiationResult`, and `TemplateInstantiationError` in both generated packages.
- Request source union: `system`, `regionRequest`, or `internal`.
- Result disposition: `created` or `existing`.
- Error codes: the stable template-instantiation subset of `DomainErrorCode`.

- [ ] **Step 1: Add the request schema**

Define a closed object requiring `protocolVersion`, `requestId`, `targetRegionId`, `template`, and `source`. Use UUID formats for identities, `^[a-f0-9]{64}$` for SHA-256 digests, closed JSON objects for parameters/configuration, and a discriminated source union:

```json
{
  "kind": "system",
  "name": "investigation-demo",
  "version": "1",
  "contentDigest": "<sha256>"
}
```

```json
{
  "kind": "regionRequest",
  "requestId": "<uuid>",
  "parentRegionId": "<uuid>",
  "requesterComponentInstanceId": "<uuid>"
}
```

```json
{
  "kind": "internal",
  "operation": "template-instantiation"
}
```

- [ ] **Step 2: Add the result schema**

Require protocol/request/region/revision identities, disposition, effective digest, resolved template identity/digest, normalized parameters, causal source, and a deterministically ordered `referencedDefinitions` array whose entries contain `kind`, UUID `id`, natural key, and content digest.

- [ ] **Step 3: Add the error schema**

Require protocol version, stable code, message, and retryability. Restrict codes to request validation, unavailable/retired references, region eligibility, topology/port/schema/fan-in validation, and instantiation conflict codes already represented by `DomainErrorCode`.

- [ ] **Step 4: Generate bindings**

Run:

```bash
pnpm contracts:validate
pnpm contracts:generate
pnpm contracts:check
```

Expected: all schemas compile; generated TypeScript/Python files and package exports are stable with no drift.

- [ ] **Step 5: Run the contract test**

Run: `pnpm vitest run scripts/template-instantiation-contracts.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit schemas and generated output**

```bash
git add contracts/schemas packages/contracts-ts packages/contracts-py scripts/template-instantiation-contracts.test.mjs
git commit -m "feat(contracts): define template instantiation protocol"
```

### Task 3: Runtime Contract Adapter and Pre-Database Validation

**Files:**

- Create: `packages/runtime-core/src/systems/template-instantiation-contract.ts`
- Modify: `packages/runtime-core/src/systems/template-instantiation-service.ts`
- Modify: `packages/runtime-core/src/systems/system-application-service.ts`
- Modify: `packages/runtime-core/src/index.ts`
- Modify: `packages/runtime-core/package.json`
- Modify: `pnpm-lock.yaml`
- Test: `packages/runtime-core/test/template-instantiation-contract.test.ts`
- Test: `packages/runtime-core/test/template-instantiation-service.test.ts`
- Test: `packages/runtime-core/test/system-application-service.test.ts`

**Interfaces:**

- Consumes: generated `TemplateInstantiationRequest` and `TemplateInstantiationResult`.
- Produces: `normalizeTemplateInstantiationRequest(input)` and `toTemplateInstantiationResult(...)`.
- Preserves: `instantiateInTransaction(transaction, request)` as the authoritative publication entrypoint.

- [ ] **Step 1: Write failing adapter tests**

Cover direct canonical requests, current string-template callers, default internal source normalization, static-system source normalization, malformed canonical request rejection before `findRegion`, and result conversion to stable IDs rather than raw database rows.

- [ ] **Step 2: Run focused runtime tests and preserve the red state**

Run:

```bash
pnpm vitest run packages/runtime-core/test/template-instantiation-contract.test.ts packages/runtime-core/test/template-instantiation-service.test.ts packages/runtime-core/test/system-application-service.test.ts
```

Expected: FAIL because the adapter does not exist and the service still exposes implementation-local request/result interfaces.

- [ ] **Step 3: Implement the adapter**

Compile the canonical request schema once with strict AJV. Normalize legacy in-process input into the canonical shape, validate before invoking `findRegion`, and throw `DomainError('invalid_declaration', ...)` with deterministic AJV diagnostics on invalid wire shape. Convert resolved rows into the generated result fields while keeping publication behavior unchanged.

- [ ] **Step 4: Route static system application through the canonical request**

Derive a deterministic UUID request identity from the system content digest and region identity, retain the existing `system` causal source, and call the same canonical transaction method for every registered topology-bearing region.

- [ ] **Step 5: Run focused and fast verification**

Run:

```bash
pnpm vitest run packages/runtime-core/test/template-instantiation-contract.test.ts packages/runtime-core/test/template-instantiation-service.test.ts packages/runtime-core/test/system-application-service.test.ts
pnpm verify:fast
```

Expected: PASS.

- [ ] **Step 6: Commit the runtime adapter**

```bash
git add packages/runtime-core pnpm-lock.yaml
git commit -m "feat(runtime): consume template instantiation contracts"
```

### Task 4: Final Verification and Documentation

**Files:**

- Modify: `docs/reference/runtime-api.md` if the existing reference index covers internal authoritative services; otherwise modify `docs/README.md` only to link the contract schemas.
- Modify: GitHub PR description and issue #72 evidence.

**Interfaces:**

- Produces: a reviewable contract reference and retained verification evidence.

- [ ] **Step 1: Document the frozen boundary**

Document protocol version, source variants, idempotency identity, created/existing behavior, stable errors, and the explicit separation from durable history (#73) and child-region lifecycle (#36/#74).

- [ ] **Step 2: Run complete repository verification**

Run:

```bash
pnpm verify
pnpm accept:m1
```

Expected: PASS locally when Docker is available; GitHub Repository Verification remains authoritative for the exact merge result.

- [ ] **Step 3: Review generated drift and scope**

Run:

```bash
pnpm contracts:validate
pnpm contracts:check
pnpm format:check
git diff --check
```

Expected: PASS with no generated or formatting drift.

- [ ] **Step 4: Commit documentation**

```bash
git add docs
git commit -m "docs: reference template instantiation contracts"
```

- [ ] **Step 5: Open the draft pull request**

The PR must close #72, reference #50/#36/#73/#74, retain the red test evidence, and list exact-head fast, Docker-backed, restart, and clean-checkout acceptance results before merge.
