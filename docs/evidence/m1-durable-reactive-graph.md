# Milestone 1 Durable Reactive Graph evidence

Status: **CI evidence recorded; Milestone 1 acceptance remains incomplete.** The reproducible repository checks and the durable investigation vertical slice passed on the Task 11 branch. A clean Codespace replay, a live control-plane process restart during an investigation, exhaustive reference-specification conformance coverage, and several operator-facing inspection proofs remain open.

Tested implementation commit SHA: `38b73c00853787367008e3180833915ba816696b`

Run date: 2026-07-15

Clean checkout location: GitHub Actions hosted `ubuntu-24.04` runner using the pull-request merge checkout. This is a clean CI checkout, **not** the required final Codespace acceptance run.

Workflow: [Repository Verification #239](https://github.com/laurajoyhutchins/factory-floor/actions/runs/29459568697)

Retained integration log: `integration-test-log-239`, artifact digest `sha256:afc9ae89c369bbf6c63b767aac20e948dd24795cb55691b40a0ce8397ac856cc`, retained through 2026-08-14.

## Recorded evidence

| Evidence item | Command or check | Recorded result | Status |
|---|---|---|---|
| Frozen dependency installation | Workflow locked install and `bash scripts/bootstrap-workspace.sh` | pnpm and uv locked environments installed; bootstrap passed | Pass |
| PostgreSQL and MinIO readiness | `pnpm services:up` and `pnpm services:wait` | Both services became healthy and passed live readiness checks | Pass |
| Database migration | `pnpm db:migrate` | Migration completed before integration execution; development reset also passed afterward | Pass |
| Contract validation and generated drift | `pnpm contracts:validate` and `pnpm contracts:check` | Both checks passed | Pass |
| Static and language test suites | lint, typecheck, workspace tests, control-plane tests, Python tests | All workflow steps passed | Pass |
| Docker-backed integration suite | `pnpm test:integration` | 7 files and 48 tests passed, including PostgreSQL and MinIO conformance | Pass |
| Successful investigation submission | `pnpm demo:investigation` | Demo returned `status: completed` with one durable command | Pass |
| Three-way retrieval fan-out | Demo acceptance query | Completed components included `retrieve-a`, `retrieve-b`, and `retrieve-c` | Pass |
| Complete fan-in and publication | Demo acceptance query | 6 of 6 executions completed; compare, verify, and synthesize all completed | Pass |
| Verifier attempt 1 deliberately failed | Demo acceptance query | Exactly 1 failed attempt with `DEMO_FIRST_ATTEMPT_INTENTIONAL_FAILURE` | Pass |
| Later verifier attempt succeeded | Demo acceptance query | 7 total attempts for 6 completed executions, demonstrating successful retry | Pass |
| Both verifier attempts remained durable | Demo acceptance query | Attempt history contained the failed attempt and the later successful attempt | Pass |
| Final outputs | Demo acceptance query | `evidence-bundle`, `result`, and `uncertainty-report` were committed | Pass |
| No duplicate outputs or downstream deliveries | Demo acceptance query | `duplicateOutputs` and `duplicateDeliveries` were both empty | Pass |
| Failed-attempt partial artifacts preserved | `atomic-commit.test.ts` | Integration test passed for preserving failed attempt history and staged partial artifacts before retry | Pass at service boundary; operator inspection capture remains open |
| Atomic artifact/effect publication | `atomic-commit.test.ts` | Successful effects and staged blob promotion passed atomically and idempotently | Pass at service boundary |
| Cancellation fencing | `observability-recovery.test.ts` | Cancellation settled once and stale-epoch result commit was rejected | Pass at service boundary |
| Repeated recovery idempotency | `observability-recovery.test.ts` | Expired attempt recovered exactly once across repeated recovery runs | Pass at service boundary |
| Projection replay purity | `observability-recovery.test.ts` | Every projection rebuilt from history without dispatch side effects | Pass |
| Artifact digest, schema, and provenance shown through operator inspection | inspection capture plus reconciliation | No retained operator-facing output yet demonstrates all three fields together | Open |
| Attributable resource entries shown through operator inspection | inspection capture | No retained operator-facing resource-ledger output yet | Open |
| Complete command-to-artifact/event trace | execution trace inspection | Trace APIs are tested, but no retained end-to-end trace capture is recorded here | Open |
| Live control-plane restart during investigation | process restart acceptance scenario | Startup recovery service behavior is tested, but the actual control-plane process is not restarted during the demo | Open |
| Exhaustive conformance to every reference invariant | full conformance manifest | Current focused suites cover core invariants but do not enumerate every reference-specification invariant | Open |
| Clean Codespace reproduction | `FACTORY_FLOOR_VERIFY_CLEAN=1 pnpm verify` from a new Codespace | Not yet executed and retained | Open |

## Investigation result excerpt

```json
{
  "status": "completed",
  "executions": 6,
  "attempts": 7,
  "completedExecutions": 6,
  "failedAttempts": 1,
  "failedAttemptCode": "DEMO_FIRST_ATTEMPT_INTENTIONAL_FAILURE",
  "componentNames": [
    "compare",
    "retrieve-a",
    "retrieve-b",
    "retrieve-c",
    "synthesize",
    "verify"
  ],
  "finalOutputPorts": [
    "evidence-bundle",
    "result",
    "uncertainty-report"
  ],
  "duplicateOutputs": [],
  "duplicateDeliveries": []
}
```

## Completion rule

Do not mark Milestone 1 complete until a clean Codespace run is retained and the open rows above are either proven or deliberately removed from the normative acceptance requirements. Expected verifier failure alone is insufficient; successful retry, durable history, and duplicate-free publication must remain visible.

Do not paste secrets, worker tokens, signed URLs, large raw logs, or volatile container identifiers into this document.
