# Production promotion boundary

Factory Floor currently uses `main` as its reviewed, releasable integration branch. It does not yet maintain a long-lived `production` branch.

## Why production is deferred

A separate operational pointer becomes valuable only when Factory Floor operates a persistent instance carrying real runs, artifacts, workers, credentials, or other durable production state. Before that boundary exists, a second long-lived branch would add synchronization cost without protecting a distinct live system.

## Activation criteria

Create a protected `production` branch only after all of the following are true:

- a persistent production instance exists;
- canonical non-watch production entrypoints are verified;
- readiness, graceful shutdown, restart, and reconciliation behavior are covered by acceptance tests;
- database and artifact-store migration and rollback procedures are documented;
- the deployed instance can report its exact repository commit;
- deployment automation can require a clean checkout matching the remote production head;
- post-deployment smoke and recovery checks are defined.

## Future branch contract

When activated:

- `main` remains the reviewed integration branch;
- `production` becomes the exact commit approved for the live instance;
- routine pull requests continue to target `main`;
- promotion fast-forwards `production` to an exact verified commit from `main`;
- direct commits, force pushes, and divergent history on `production` are prohibited;
- deployment records the exact SHA and fails closed if the branch moves or the target checkout differs.

Until these criteria are satisfied, use exact-SHA test evidence and release tags rather than a placeholder production branch.
