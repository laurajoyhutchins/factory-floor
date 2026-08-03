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

### Portfolio Control Plane reads

The `./portfolio` export provides a separate `createPortfolioClient` for the source-neutral Portfolio Control Plane. It exposes only bounded `GET` operations for status, entities, one entity, deterministic next-work selection, owner decisions, and search. Responses remain opaque projection records so the client cannot silently reinterpret LORE, Deciduous, GitHub, Linear migration evidence, or execution evidence.

```ts
import { createPortfolioClient } from '@factory-floor/operator-client-ts/portfolio';

const portfolio = createPortfolioClient({
  baseUrl: portfolioReadProxyUrl,
  token: shortLivedPortfolioReadToken,
});
```

The portfolio client has no outcome, owner-decision request, ingestion, reconciliation, execution, or other mutation method. It retries transient reads only.

## `@factory-floor/operator-ui-react`

The React package owns reusable overview, portfolio, topology, execution trace, artifact lineage, template-instantiation, resource, policy, projection, and operations views. It also exposes bounded run-status, run-topology, durable trace, current-alert, finite-event, run-artifact, and pending-approval panels over the authoritative operator HTTP API.

The views preserve textual graph alternatives, keyboard navigation, responsive layouts, opaque JSON rendering, loading and disconnected states, and reduced-motion behavior. Pending approvals remain read-only until the safe mutation workflow is added through the existing idempotent operator command boundary.

`Portfolio` receives an optional `PortfolioClient`. Without one it renders an explicit unconfigured state and performs no request. With one it loads independent status, next-work, owner-decision, and semantic-work reads in parallel. It does not claim work or record outcomes.

The host still owns:

- route registration and top-level providers;
- authentication and session bootstrap;
- host SDK integration;
- deployment and proxy configuration.

The standalone console is the first consumer. Its only client-specific module reads Vite environment values, creates the reusable clients, and configures the default facade before rendering the shared views.

For a trusted private standalone build, the Portfolio page is enabled with `VITE_PORTFOLIO_CONTROL_PLANE_URL`. `VITE_PORTFOLIO_CONTROL_PLANE_TOKEN` is optional and must never contain a long-lived administrative credential. Public or shared deployments must use an authenticated same-origin read proxy or a short-lived audience-limited read token rather than embedding an admin token in browser assets.

## Boundary rules

Neither package imports database repositories, runtime service implementations, control-plane source, worker credentials, admin credentials, Hatchable SDKs, or host SDKs. Factory Floor's operator HTTP API remains the authoritative runtime and event source. The Portfolio Control Plane remains the authoritative source-neutral coordination projection. LORE remains authoritative for accepted knowledge, Deciduous for causal development history, GitHub for source and exact-head evidence, and Linear only for migration evidence.
