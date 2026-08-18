# Production deployment identity

Factory Floor uses `main` as its only long-lived integration branch. Production identity is represented by an exact verified repository coordinate, not by a second permanent `production` branch.

## Why there is no production branch

A long-lived deployment branch would duplicate repository state without creating a stronger authority boundary. The live system needs an immutable answer to a narrower question:

> Which exact reviewed Factory Floor revision is this deployment running?

That fact is better represented by an exact commit SHA together with the deployment, release, tag, or immutable deployment receipt that selected it.

`main` may continue to advance after a deployment. The deployed revision does not.

## Production-readiness criteria

A persistent production deployment should not be promoted until all applicable readiness conditions are satisfied:

- canonical non-watch production entrypoints are verified;
- readiness, graceful shutdown, restart, and reconciliation behavior are covered by acceptance tests;
- database and artifact-store migration and rollback procedures are documented;
- the deployed instance can report its exact repository commit;
- deployment automation requires a clean checkout of the selected exact revision;
- post-deployment smoke and recovery checks are defined;
- repository-owned verification has passed for the exact candidate under the current verification contract.

These are deployment gates. Satisfying them does not create or require another long-lived branch.

## Deployment contract

When a revision is selected for a live instance:

- ordinary pull requests continue to target `main`;
- the deployment selects one exact verified commit reachable through the repository's accepted integration history;
- the deployment record stores that exact SHA and, where useful, an immutable release or tag coordinate;
- deployment fails closed if the checkout differs from the selected revision;
- post-deployment evidence is attributed to the deployed exact SHA;
- rollback selects another explicit previously verified deployment coordinate rather than moving an implicit environment branch;
- force pushes or branch movement cannot redefine the identity of an already recorded deployment.

## Tags and releases

Tags and releases may provide durable human-facing names for deployment coordinates, but they do not replace the commit identity they reference. Any production receipt should retain the exact SHA even when a release or tag is also recorded.

## Historical note

An earlier repository decision proposed creating a protected long-lived `production` branch after a persistent production instance existed. That proposal is superseded by the portfolio branch policy: `main` is the sole long-lived branch, and production state is represented by exact deployment identity instead.
