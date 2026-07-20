# Worker protocol compatibility and deprecation ledger

**Status:** Current

This ledger records temporary public aliases retained by the supported worker protocol v1 SDKs. The canonical names are the only names used on the wire and in new code.

## Policy

- Worker protocol v1 remains frozen for the lifetime of the 1.x SDK line.
- A compatibility alias must normalize to the canonical v1 request or value without changing durable runtime semantics.
- Every alias must retain automated coverage until it is removed.
- New compatibility aliases require an entry here in the same pull request that introduces them.
- Removal is a protocol v2 breaking change tracked by [issue #107](https://github.com/laurajoyhutchins/factory-floor/issues/107).

## Active aliases

### `WORKER-V1-PY-CLAIM-CAPABILITIES`

- **SDK surface:** Python `WorkerClient.claim`
- **Legacy alias:** `capabilities=`
- **Canonical replacement:** `component_selectors=`
- **Supported versions:** Worker protocol v1 and Python SDK 0.1.x
- **Warning behavior:** Silent normalization in v1 so long-running worker poll loops do not emit repeated warnings. Documentation and the conformance case identify the alias as deprecated.
- **Automated evidence:** `contracts/conformance/worker-protocol-v1.cases.json` case `claim.deprecated-capabilities` and `packages/worker-sdk-py/tests/test_conformance_claim.py`
- **Owner:** Worker SDK maintainers
- **Removal plan:** Remove from the protocol v2 Python SDK under #107 after supported workers use `component_selectors=`.

### `WORKER-V1-TS-REGISTRY-CAPABILITIES`

- **SDK surface:** TypeScript `ComponentRegistry`
- **Legacy alias:** `capabilities()`
- **Canonical replacement:** `supportedComponentSelectors()`
- **Supported versions:** Worker protocol v1 and TypeScript SDK 0.1.x
- **Warning behavior:** TypeScript JSDoc `@deprecated`; no runtime warning so worker startup remains deterministic and quiet.
- **Automated evidence:** `packages/worker-sdk-ts/test/deprecation-compatibility.test.ts`
- **Owner:** Worker SDK maintainers
- **Removal plan:** Remove from the protocol v2 TypeScript SDK under #107 after supported workers use `supportedComponentSelectors()`.

## Protocol v2 cleanup gate

Issue #107 may remove an alias only after all supported workers and examples use the canonical API, the v2 migration guide identifies the breaking change, and repository verification proves that the alias is no longer required. Protocol v1 fixtures remain frozen historical evidence after removal from v2.
