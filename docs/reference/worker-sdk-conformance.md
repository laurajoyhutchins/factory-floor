# Worker SDK conformance

Status: supported worker protocol v1 boundary

Factory Floor supports a worker SDK only after it consumes the shared language-neutral conformance corpus and produces the same normalized outcomes as the existing TypeScript and Python SDKs.

## Authoritative inputs

The conformance harness does not define runtime semantics. These remain authoritative:

- JSON Schemas under `contracts/schemas/`;
- generated language bindings;
- the control-plane worker protocol service;
- durable integration and acceptance tests.

The reusable SDK corpus is `contracts/conformance/worker-protocol-v1.cases.json`, validated by `contracts/conformance/worker-protocol-v1.cases.schema.json`. It describes HTTP requests, responses, shared fixtures, and normalized outcomes without importing control-plane or runtime implementation code.

## Current implementations

The supported adapters are:

- TypeScript: `packages/worker-sdk-ts/test/conformance-claim.test.ts` and `conformance-operations.test.ts`;
- Python: `packages/worker-sdk-py/tests/test_conformance_claim.py` and `test_conformance_operations.py`.

Both adapters consume every applicable case from the same corpus. They may translate language-specific public APIs into canonical wire requests, but may not reinterpret durable runtime semantics.

The suite covers claim/no-work behavior, invocation-envelope decoding, deprecated claim normalization, lease and stale-epoch errors, cancellation observation, artifact staging and exact upload bytes, capability denial, accepted and duplicate results, malformed responses, and retry-safe transport behavior.

## Stable normalized outcomes

Adapters report the corpus classifications rather than language-specific exception class names:

- `claimed` and `no_work`;
- `lease_error`;
- `staged`;
- `capability_denied`;
- `accepted`, `duplicate`, and `conflict`;
- `protocol_error`.

The SDK itself must expose enough stable error metadata to derive these outcomes. TypeScript and Python use the same error-kind vocabulary for authentication, invalid requests, unsupported versions, transient failures, lease failures, conflicts, capability denial, protocol validation, network failure, and cancellation.

## Adding another supported SDK

A future SDK becomes supported only after one pull request does all of the following:

1. Generate or consume bindings from the existing canonical schemas. Do not copy or fork those schemas.
2. Implement the frozen worker HTTP protocol without importing `runtime-core`, database repositories, control-plane source, or committed artifact-storage internals.
3. Add corpus adapters that execute every relevant case and return the existing normalized classifications.
4. Add the implementation and adapter paths to `scripts/check-worker-sdk-conformance.mjs`.
5. Prove canonical request normalization, stable error kinds, exact artifact bytes, duplicate-result handling, cancellation, and retry behavior.
6. Pass `pnpm verify:static`, `pnpm verify:unit`, clean-checkout verification, and the repository's exact-head review policy.

Placeholder SDK packages are not accepted. A new language must have a concrete supported worker or host implementation and must join this corpus before documentation calls it supported.

## Verification and retained evidence

`pnpm worker-sdk:conformance:check` validates the corpus schema, required cases, fixture paths, supported adapters, and deprecated-field normalization. Static verification runs this command and writes `.factory-floor/ci-metrics/worker-sdk-conformance.json`.

The actual TypeScript and Python behavioral results are retained through the root unit-test JUnit evidence. Any corpus, fixture, generated-contract, SDK behavior, or normalized-classification drift fails repository verification.
