# Milestone 1 Durable Reactive Graph evidence

Status: **Incomplete draft**. Task 11 began before all Task 9 and Task 10 final acceptance dependencies were available on this branch. Do not treat this document as acceptance evidence until it is updated from an actual clean Codespace run after those branches merge.

Tested commit SHA: _pending_
Run date: _pending_
Clean checkout location: _pending_
Full logs: _pending_

| Evidence item | Exact command | Result excerpt | Date | Commit SHA | Status |
|---|---|---|---|---|---|
| Dependency installation from frozen lockfiles | `bash scripts/bootstrap-workspace.sh` | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| PostgreSQL and MinIO readiness | `pnpm services:up && pnpm services:wait` | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Successful migration | `pnpm db:migrate` | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Schema/contract generation drift check | `pnpm contracts:validate && pnpm contracts:check` | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Successful investigation submission | `pnpm demo:investigation` | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Three-way retrieval fan-out | inspection command pending | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Complete fan-in | inspection command pending | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Verifier attempt 1 deliberately failing | inspection command pending | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Later verifier attempt succeeding | inspection command pending | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Both attempts visible | `ff inspect attempts --json` | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Failure and partial artifacts inspectable | `ff inspect artifacts --json` | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Artifact digest/schema/provenance validation | inspection plus reconciliation pending | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| No duplicate outputs or downstream deliveries after retry | inspection command pending | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Attributable resource entries | inspection command pending | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Complete command-to-artifact/event trace | trace inspection command pending | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Control-plane restart without lost or duplicated work | restart acceptance command pending | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Cancellation fencing stale results | cancellation acceptance command pending | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Projection rebuild without worker dispatch or external actions | `pnpm projections:rebuild` plus inspection | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |
| Final lint/typecheck/unit/Python/integration/conformance | `pnpm verify` | _pending actual clean run_ | _pending_ | _pending_ | Incomplete |

## Notes

- Expected deliberate verifier failure is not enough; the successful retry and preserved history must be shown by actual output.
- Do not paste secrets, worker tokens, signed URLs, large logs, or volatile container identifiers into this file.
