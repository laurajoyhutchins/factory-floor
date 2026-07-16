# Milestone 1 Durable Reactive Graph evidence

Status: **accepted.** Repository Verification #289 reproduced every applicable Milestone 1 requirement from a fresh GitHub Actions hosted checkout and retained a sanitized operator evidence bundle. Capability delegation and dynamic child-region construction remain explicitly deferred beyond the static Milestone 1 scope.

## One-command acceptance

Run from a clean checkout configured from `.env.example`:

```bash
pnpm accept:m1
```

The command bootstraps the workspace, validates contracts and conformance structure, starts clean PostgreSQL and MinIO services, runs migrations and quality gates, executes the investigation vertical slice, exercises live control-plane restart and cancellation fencing, rebuilds projections, reconciles artifacts, records a durable policy decision, collects operator-facing inspection output, sanitizes retained logs, and stops services on success, failure, interruption, or timeout.

## Implementation evidence

- The conformance ledger enumerates exactly 18 normative reference invariants. Every invariant applicable to the static Milestone 1 runtime is automated and passed.
- Operator inspection exposes artifact schema identity and digest, committed state, locator status, provenance, derivations, and tombstone state.
- Operator inspection exposes resource-ledger entries by region, execution, attempt, external action when present, resource type, quantity, and unit.
- Registered policy evaluation durably records policy identity and version, evaluator version, subject, normalized inputs, referenced artifact, outcome, reason, modifications, and approval relationship.
- Delivery evidence enumerates every relevant delivery and fails acceptance if one remains outside `completed`, `cancelled`, or `dead_lettered`.
- The retained bundle is sanitized on every acceptance exit path, including failed runs.

## Automated CI evidence

Repository Verification runs the ordinary repository suite first and then starts a separate clean hosted runner for:

```bash
pnpm accept:m1
```

| Field | Accepted value |
| --- | --- |
| Workflow | Repository Verification #289 |
| Workflow run ID | `29479516913` |
| Reviewed PR head | `9da05cfe8347279d8777926d7fade863df8ea037` |
| Actions-tested merge commit | `367482a4891b8b3a1d92185069f7c53aaa9a15cd` |
| Evidence artifact | `m1-acceptance-evidence-289` |
| Artifact ID | `8367989997` |
| Artifact digest | `sha256:eeea4e2b894b3b09ae28276c3db3625ff0add93229c1f0f4eb9c46a425d31394` |
| Environment | GitHub Actions hosted Linux runner, fresh checkout |
| Clean-checkout attestation | `true` |
| Acceptance result | `passed` |

The downloaded artifact was inspected before acceptance. All 15 applicable acceptance checks were true. The archive contained no raw database password, bearer token, lease token, signed token URL, or GitHub credential.

## Retained operator evidence

The evidence bundle records:

- one accepted command;
- six completed logical executions;
- seven final-investigation attempts, including the deliberate verifier failure and successful replacement;
- eight terminal deliveries with no duplicate output or downstream-delivery keys;
- eight committed artifacts with valid digest, schema identity, provenance, and lineage;
- resource attribution for the failed and replacement verifier attempts;
- one durable `require_approval` policy decision and requested approval;
- six complete execution traces and eight artifact-lineage records;
- live-restart abandonment, replacement, recovery summary, stale-result fencing, and duplicate-free completion;
- cancellation epoch increment, cancelled attempt and delivery, stale-result rejection, and zero committed stale outputs;
- projection replay with unchanged delivery, execution, and external-action counts;
- ten caught-up projection checkpoints;
- reconciliation of eight consistent artifacts with zero unresolved records.

The bundle includes `acceptance-evidence.json`, `SUMMARY.md`, and sanitized scenario logs. Private model reasoning is neither required nor retained.

## Clean-environment evidence

The accepted run used a separate GitHub Actions job after ordinary verification. It began from a fresh checkout with no reused `node_modules`, Python environment, database volumes, or artifact store and set `FACTORY_FLOOR_CLEAN_CHECKOUT=1`.

An actual GitHub Codespace was not used. The Milestone 1 completion rule permits a comparably fresh hosted checkout, so the clean-environment criterion is satisfied without making a Codespace-specific claim.

## Formatting baseline

Repository-wide `pnpm format:check` remains red because `main` has broad pre-existing Prettier drift across 101 files. This is recorded as repository baseline debt rather than attributed to Task 12C. Every Task 12C file supported by Prettier passes the scoped acceptance formatting check.

## Deferred post-Milestone-1 invariants

- `M1-CONF-006` — capability delegation cannot exceed parent authority. Deferred because Milestone 1 uses direct capability grants and exposes no delegation surface.
- `M1-CONF-007` — dynamic regions cannot modify ancestor topology. Deferred because dynamic child-region construction is outside Milestone 1.
- `M1-CONF-015` — dynamic construction is explicitly bounded. Deferred because Milestone 1 uses a static committed investigation graph.
