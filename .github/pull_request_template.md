## Summary

<!-- What changed, and why is this the smallest coherent change? -->

Closes #

## Change risk

- [ ] Low — documentation, tests, or isolated internal behavior
- [ ] Medium — runtime behavior with bounded durable or compatibility impact
- [ ] High — authority, authentication, transactions, migrations, contracts, recovery, or external actions

Explain the selected risk and any unusually large change surface:

## Invariants and authority

List every affected conformance or runtime invariant. State `None` only when behavior is genuinely non-normative.

- Affected invariants:
- Authority or capability boundary changes:
- Evidence path for each affected invariant:

## Durable state and transactions

- Database schema or migration changes:
- Durable records created, updated, or deleted:
- Transaction, locking, fencing, or atomicity effects:
- Artifact-store or reconciliation effects:

## Contracts and compatibility

- Public, operator, worker, SDK, schema, or generated-contract changes:
- Backward-compatibility behavior:
- Rollout and rollback strategy:

## Failure semantics

Describe behavior for retries, duplicate submission, replay, cancellation, stale authority, partial failure, restart, and indeterminate external outcomes as applicable.

- Idempotency identity:
- Retry and backoff behavior:
- Replay and recovery behavior:
- Failure classification and retained evidence:

## Verification

List exact commands and retained CI evidence. Do not use “tests pass” without naming the test or gate.

- [ ] `pnpm verify:static`
- [ ] `pnpm verify:unit`
- [ ] `pnpm verify:services`
- [ ] `pnpm verify:integration`
- [ ] `pnpm verify:acceptance`
- [ ] Milestone 1 clean acceptance
- [ ] Relevant focused regression tests

Evidence and results:

## Deferred work

List deliberate follow-ups with issue links, or state `None`.
