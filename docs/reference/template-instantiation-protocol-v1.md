# Template instantiation protocol v1

Status: active Milestone 2 contract

The template-instantiation protocol defines the language-neutral boundary for asking Factory Floor to instantiate one registered template into one eligible target region. It freezes request, result, and error shapes without creating an HTTP endpoint or changing the authority of the runtime service that validates and publishes topology.

The canonical JSON Schemas are:

- `contracts/schemas/template-instantiation-request.schema.json`
- `contracts/schemas/template-instantiation-result.schema.json`
- `contracts/schemas/template-instantiation-error.schema.json`

The existing contract-generation pipeline publishes matching TypeScript and Python bindings through `@factory-floor/contracts-ts` and `factory_floor_contracts`.

## Request

Every request uses `protocolVersion: "1.0"` and contains:

- `requestId`: a UUID supplied by the caller for attribution and response correlation.
- `targetRegionId`: the UUID of the eligible region that will receive the topology.
- `template`: the registered template natural key `{ name, version }`.
- `parameters`: optional JSON parameters, defaulting to an empty object.
- `componentConfiguration`: optional per-instance JSON configuration overrides, defaulting to an empty object.
- `source`: one of the closed source variants below.

Unknown fields, malformed UUIDs, unsupported source variants, and non-JSON parameter or configuration values are rejected before the canonical adapter invokes the database-backed runtime.

### Source variants

`system` identifies an immutable registered system declaration by natural key and content digest:

```json
{
  "kind": "system",
  "name": "investigation-demo",
  "version": "1",
  "contentDigest": "<sha256>"
}
```

`regionRequest` identifies a future bounded dynamic-region request and its authoritative parent/requester relationship:

```json
{
  "kind": "regionRequest",
  "requestId": "<uuid>",
  "parentRegionId": "<uuid>",
  "requesterComponentInstanceId": "<uuid>"
}
```

`internal` identifies an attributable control-plane operation that is not sourced from a system or child-region request:

```json
{
  "kind": "internal",
  "operation": "template-instantiation"
}
```

A `regionRequest` source is a contract shape only in this slice. Child-region authority, bounds, construction, and lifecycle remain owned by issues #36–#38.

## Result

A successful result contains:

- the original `requestId` and protocol version;
- `disposition`, either `created` or `existing`;
- the effective instantiation digest;
- stable region and topology-revision identities;
- the resolved template identity, natural key, and content digest;
- normalized parameters and the causal source;
- a non-empty, deterministically ordered list of referenced template, component, schema, policy, and capability definitions with immutable identities and content digests.

`existing` means the target region already has the same effective active topology. A different active topology produces `template_instantiation_conflict`; it is never silently replaced.

## Errors

The error schema exposes only stable domain outcomes that callers can handle without learning database or implementation details. It includes declaration validation, unavailable or retired definitions, region eligibility, topology and port/schema validation, fan-in validation, instantiation conflict, and transient internal failure.

Database constraint names, SQLSTATE values, stack traces, and repository implementation types are not protocol fields.

## Runtime adapter and compatibility

`TemplateInstantiationContractService` is the canonical in-process adapter. It validates the complete request before invoking `TemplateInstantiationService`, translates the natural-key request into the existing authoritative runtime call, and converts internal region/revision rows into the stable protocol result.

Existing static-system application continues to use the implementation-local request shape against the same authoritative `TemplateInstantiationService`. It remains compatible without creating a second validation or topology-publication implementation; direct canonical consumption by the child-region boundary is deferred to issue #74.

## Authority and deferred work

This protocol does not make request identity or instantiation history durable by itself. First-class durable instantiation identity, initial-state publication, lineage, projections, and inspection remain issue #73. PostgreSQL concurrency evidence and direct consumption by the child-region boundary remain issue #74. Dynamic child construction remains issue #36.
