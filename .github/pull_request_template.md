## Summary

<!-- What changed, and why is this the smallest coherent change? -->

Closes #

## Agent handoff

- Lifecycle state: `implementing | self-review | awaiting-ci | needs-attention | ready`
- Head SHA reviewed:
- Base branch and SHA:
- Current work:
- Open findings or review threads:
- External blocker:
- Next action:

The automated sticky handoff comment is resumable state, not approval. Update this section when scope, blockers, or the reviewed head changes.

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

## Review discipline

- [ ] A fresh self-review covered the issue, complete current diff, security and authority boundaries, failure semantics, compatibility, and missing tests.
- [ ] All actionable review threads are resolved or linked to explicit follow-up issues.
- [ ] TDD red-state evidence is retained without leaving required CI intentionally red.
- [ ] The final reviewed SHA matches the successful required-check SHA.

## Verification

List exact commands and retained CI evidence. Do not use “tests pass” without naming the test or gate.

- [ ] `pnpm verify:static`
- [ ] `pnpm verify:unit`
- [ ] `pnpm verify:services`
- [ ] `pnpm verify:integration`
- [ ] `pnpm verify:acceptance`
- [ ] Milestone 1 clean acceptance
- [ ] Relevant focused regression tests
- [ ] `agent-ci-summary.json` retained for every verification job

Evidence and results:

## Deferred work

List deliberate follow-ups with issue links, or state `None`.
