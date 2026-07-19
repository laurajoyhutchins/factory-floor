# Pull-request review clearance

Every pull request must retain a durable final-review record for its exact current head revision before merge. The repository publishes that decision as the `review / cleared` commit status so GitHub rules can enforce it.

## Required final-review comment

The repository owner posts one top-level pull-request comment in this exact structure:

```markdown
<!-- review-clearance:v1 -->

## Final review

Reviewed head: `<full 40-character commit SHA>`

Scope reviewed:

- complete current diff
- relevant invariants, failure behavior, security, tests, and documentation

Findings and changes:

- concise summary, or `None.`

Verification:

- exact-head commands and GitHub Actions runs

Remaining limitations:

- concise limitations, or `None.`

Disposition: Cleared for merge.
```

Use `Disposition: Not cleared for merge.` when review finds an unresolved blocker. The latest owner-authored comment containing the `review-clearance:v1` marker is authoritative.

## Enforcement semantics

- Only a comment authored by the repository owner is accepted.
- The reviewed SHA must exactly match the pull request's current 40-character head SHA.
- A new commit makes every previous clearance stale automatically.
- The authoritative exact-head `Repository Verification` workflow must complete successfully.
- Every review conversation must be resolved, and inability to read the complete thread state blocks clearance.
- Draft pull requests and pull requests without an exact-head clearance remain pending.
- The privileged clearance workflow checks out only trusted code from the default branch and never executes pull-request code.

The sticky `Agent PR handoff` comment remains a resumable readiness snapshot. It is not the final review decision and does not satisfy `review / cleared`.
