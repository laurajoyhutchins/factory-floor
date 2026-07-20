# Verification cadence

**Status:** Current

Factory Floor separates required pull-request verification from full clean-environment acceptance according to measured overlap rather than intuition.

## Pull requests

Every pull request runs the canonical Repository Verification lanes:

1. static verification;
2. unit verification and the console production build;
3. Docker-backed service startup and migrations;
4. integration tests and the investigation demo;
5. live-restart acceptance.

The stable `verify` status represents those exact-head lanes. The existing `m1-acceptance` job remains present so workflow and handoff identifiers do not churn, but `scripts/accept-m1.sh` records an explicit `deferred_to_trusted_cadence` evidence bundle instead of repeating the complete clean suite during a pull-request event.

## Main and direct invocation

A push to `main` runs the complete clean-checkout Milestone 1 acceptance path. Developers and release operators can run the same path directly with:

```bash
bash scripts/accept-m1.sh
```

The full path retains all previously accepted guarantees:

- clean bootstrap from locked JavaScript and Python dependencies;
- static and unit verification;
- fresh PostgreSQL and MinIO startup and migrations;
- integration and investigation execution;
- live-restart recovery and stale-result fencing;
- cancellation fencing;
- deliberate failure and replacement-attempt evidence;
- durable policy decisions;
- artifact identity, provenance, lineage, reconciliation, and projection replay;
- clean-checkout attestation and sanitized evidence publication.

Each logical phase writes a metric under `.factory-floor/ci-metrics/m1-*.json`. The outer `m1-clean-acceptance.json` continues to record total elapsed time.

## Measured baseline

Repository Verification run 565 measured the complete clean path at 161.878 seconds. Separately measured canonical stages repeated inside that path totaled 130.405 seconds, or at least 80.56% of the full duration. The estimate excludes repeated bootstrap and investigation setup, so it is a lower bound.

The machine-readable source, phase classification, and exact measurements are stored in [`m1-acceptance-baseline.json`](m1-acceptance-baseline.json).

## Change rule

Do not remove a clean-acceptance scenario merely because a command name appears elsewhere. A scenario may leave the pull-request cadence only when its equivalent canonical lane is identified and measured. Recovery-specific, clean-environment-specific, and evidence-producing behavior remains in the full trusted-cadence script until replacement evidence is approved.
