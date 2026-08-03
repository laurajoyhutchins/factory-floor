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

A server-rendered or runtime-authenticated host may inject a short-lived read credential directly into the client:

```ts
import { createPortfolioClient } from '@factory-floor/operator-client-ts/portfolio';

const portfolio = createPortfolioClient({
  baseUrl: portfolioReadProxyUrl,
  token: shortLivedPortfolioReadToken,
});
```

The configured base URL must use HTTP or HTTPS and must not contain credentials, a query, or a fragment. Hosts may omit `token` when authentication is provided by an HTTP-only session cookie or a same-origin authenticated read proxy.

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

For a trusted private standalone build, the Portfolio page is enabled with `VITE_PORTFOLIO_CONTROL_PLANE_URL`. The standalone Vite build deliberately accepts no Portfolio bearer-token environment variable because `VITE_*` values are compiled into browser assets. The configured endpoint must therefore authenticate reads through a secure HTTP-only session or an authenticated same-origin proxy. Runtime hosts that can inject genuinely short-lived credentials may use the reusable client's `token` option without adding that credential to static build configuration.

## Boundary rules

Neither package imports database repositories, runtime service implementations, control-plane source, worker credentials, admin credentials, Hatchable SDKs, or host SDKs. Factory Floor's operator HTTP API remains the authoritative runtime and event source. The Portfolio Control Plane remains the authoritative source-neutral coordination projection. LORE remains authoritative for accepted knowledge, Deciduous for causal development history, GitHub for source and exact-head evidence, and Linear only for migration evidence.
