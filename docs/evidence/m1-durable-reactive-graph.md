# Milestone 1 Durable Reactive Graph evidence

Status: **acceptance command and CI retention are ready; final Milestone 1 declaration depends on the retained `pnpm accept:m1` run for the reviewed commit.** This record distinguishes implemented evidence from generated operator evidence and does not claim a Codespace run unless one is explicitly recorded below.

## One-command acceptance

Run from a clean checkout configured from `.env.example`:

```bash
pnpm accept:m1
```

The command bootstraps the workspace, validates contracts and conformance structure, starts clean PostgreSQL and MinIO services, runs migrations and all quality gates, executes the investigation vertical slice, runs the process-level restart scenario, rebuilds projections, reconciles artifacts, records a durable policy-decision proof, writes sanitized evidence under `.factory-floor/evidence/m1/`, and stops services on success, failure, interruption, or timeout.

## Implementation evidence

- The conformance ledger enumerates exactly 18 normative reference invariants. Applicable Milestone 1 invariants are automated and passed; delegation plus dynamic-construction invariants remain explicitly deferred to the bounded dynamic-region milestone.
- Operator-facing inspection exposes artifact schema identity, schema digest, committed state, locator status, provenance, derivations, and tombstone status through inspection APIs/CLI surfaces.
- Operator-facing inspection exposes resource-ledger entries by attempt, execution, region, external action when present, resource type, quantity, and unit.
- Durable policy-decision evidence records policy identity/version, evaluator version, subject kind/identity, normalized inputs, referenced artifact, outcome, reason, modifications, and the approval relationship.
- Delivery acceptance evidence enumerates every relevant delivery and fails if any delivery remains outside `completed`, `cancelled`, or `dead_lettered`.

## Automated CI evidence

Repository Verification now runs both:

```bash
pnpm conformance:check
pnpm accept:m1
```

CI uploads `.factory-floor/evidence/m1/` and the acceptance log as `m1-acceptance-evidence-${{ github.run_number }}` on success and failure. Exact GitHub Actions run and artifact identifiers must be filled in after the final successful workflow run for the reviewed commit.

| Field              | Value                |
| ------------------ | -------------------- |
| Final workflow run | Pending final CI run |
| Evidence artifact  | Pending final CI run |
| Commit SHA         | Pending final CI run |

## Process-level restart evidence

The live restart harness kills and restarts the real control-plane process while verifier attempt 2 is in flight, waits for lease expiration, verifies startup recovery abandons the stale attempt, submits a stale result and observes fencing, then verifies replacement completion without duplicate outputs or downstream deliveries.

## Operator-facing inspection evidence

The retained bundle contains:

- `acceptance-evidence.json` — sanitized machine-readable environment, commit, ledger summary, command IDs, all logical investigation executions, all attempts, failure codes, retry decisions, delivery states, artifacts, derivations, resources, traces, lineage, projection checkpoints, duplicate checks, policy decisions, and deferred items.
- `SUMMARY.md` — concise operator summary with counts and pass/fail checks.

The bundle intentionally excludes secrets, bearer tokens, database passwords, signed URLs, and private reasoning.

## Clean-environment evidence

The acceptance command is designed for a clean Codespace or equivalent clean checkout: no pre-existing `node_modules`, Python environment, database volumes, or artifact store, with configuration created from `.env.example`.

A Codespace run has **not** been performed from this session. If the final verification environment is GitHub Actions rather than Codespaces, record that accurately in the table above and keep any separate Codespace acceptance claim pending until a Codespace run actually occurs.

## Deferred post-Milestone-1 invariants

- `M1-CONF-006` — capability delegation cannot exceed parent authority. Deferred because Milestone 1 uses direct capability grants and exposes no delegation surface.
- `M1-CONF-007` — dynamic regions cannot modify ancestor topology. Deferred because dynamic child-region construction is outside Milestone 1.
- `M1-CONF-015` — dynamic construction is explicitly bounded. Deferred because Milestone 1 uses a static committed investigation graph.
