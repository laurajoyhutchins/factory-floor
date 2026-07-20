# Reusable operator packages

Factory Floor exposes reusable clients and views without moving runtime authority into browser or host code.

## `@factory-floor/operator-client-ts`

The TypeScript client owns:

- authenticated operator and read-only inspection HTTP requests;
- durable principal and adapter attribution;
- runtime response validation and canonical errors;
- opaque cursor preservation and deterministic pagination helpers;
- bounded finite run-event pages and reconnect cursors;
- retry of transient `GET` requests only.

Construct a client with injected host authentication:

```ts
const client = createOperatorClient({
  baseUrl: 'https://factory.example',
  token: shortLivedHostToken,
  principalId: externalPrincipalId,
  adapter: 'embedded-host',
});
```

Mutation retries remain the caller's responsibility and must reuse the same durable `clientRequestId`.

## `@factory-floor/operator-ui-react`

The React package owns reusable overview, topology, execution trace, artifact lineage, template-instantiation, resource, policy, projection, and operations views. It also exposes bounded run-status, run-topology, durable trace, current-alert, finite-event, run-artifact, and pending-approval panels over the authoritative operator HTTP API.

The views preserve textual graph alternatives, keyboard navigation, responsive layouts, opaque JSON rendering, loading and disconnected states, and reduced-motion behavior. Pending approvals remain read-only until the safe mutation workflow is added through the existing idempotent operator command boundary.

The host still owns:

- route registration and top-level providers;
- authentication and session bootstrap;
- host SDK integration;
- deployment and proxy configuration.

The standalone console is the first consumer. Its only client-specific module reads Vite environment values, creates the reusable client, and configures the default facade before rendering the shared views.

## Boundary rules

Neither package imports database repositories, runtime service implementations, control-plane source, worker credentials, admin credentials, or host SDKs. Factory Floor's operator HTTP API remains the authoritative runtime and event source.
