# Pull-request integration eligibility

Every pull request must retain durable technical integration evidence for its exact current head before merge. The repository publishes that decision as the existing `review / cleared` commit status so GitHub rules can enforce it.

Routine merge eligibility does **not** require a fresh repository-owner review when standing delegated authority applies and the delegated evidence below is complete.

## Delegated integration evidence

A trusted repository-associated actor records routine technical integration evidence in this structure:

```markdown
<!-- integration-evidence:v1 -->

Head: `<full 40-character commit SHA>`
Verification: Repository Verification passed for this exact head.
Review threads: 0
Owner impact: none
Provenance: agent:<worker-or-session-id>
Limitations: <concise limitations, or None.>
```

`Provenance` may use an `agent:` or `system:` identity. Self-asserted evidence from an untrusted GitHub actor is ignored. Delegated evidence can clear only when `Owner impact: none` and `Review threads: 0` are recorded.

Material owner impact must not produce delegated merge eligibility. Escalate owner-impacting choices through the portfolio execution policy instead of encoding them as routine integration evidence.

## Legacy owner review records

Existing owner-authored `<!-- review-clearance:v1 -->` records remain readable during migration. A complete legacy record for the exact current head can still clear or withhold that head, and the latest qualifying evidence record remains authoritative.

New routine work should use `integration-evidence:v1`; a legacy owner comment is no longer required for delegated merge eligibility.

## Enforcement semantics

- The evidence SHA must exactly match the pull request's current 40-character head SHA.
- A new commit makes previous exact-head evidence stale automatically.
- The authoritative exact-head `Repository Verification` workflow must complete successfully.
- Every review conversation must be resolved, and inability to read complete thread state blocks eligibility.
- Draft pull requests remain pending.
- Delegated evidence requires trusted repository association, agent/system provenance, zero recorded review threads, and `Owner impact: none`.
- The privileged `review / cleared` workflow checks out only trusted code from the default branch and never executes pull-request code.

The sticky `Agent PR handoff` comment is only a declarative, resumable repository-state snapshot. It is not an approval, an integration-evidence record, or an instruction surface.
