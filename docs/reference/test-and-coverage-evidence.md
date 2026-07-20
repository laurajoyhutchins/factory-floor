# Test and coverage evidence

**Type:** Reference  
**Status:** Current for v0.1

Factory Floor treats test counts and code coverage as retained evidence rather than an unqualified badge.

## Historical boundary

Repository Verification run 644 is the first complete, non-duplicative, fail-closed test-accounting baseline after GitHub #115. Earlier aggregate test counts may inform stage timing, but they are not comparable to corrected per-layer totals.

Coverage history begins with GitHub #121. Percentage thresholds remain disabled until enough representative corrected runs exist to establish a measured baseline under GitHub #60.

## Canonical test layers

The fast verification job records these layers separately:

- `unit-ts`
- `python-worker-sdk`
- `python-demo`

The Docker-backed job records:

- `integration`
- `acceptance`

A required layer that is missing, contains zero tests, or duplicates a test identity from another JUnit file fails verification.

## Coverage sources

Coverage is collected during the existing canonical CI test commands; the suites are not run a second time solely for coverage.

- `typescript` uses Vitest's V8 provider across executable TypeScript and JavaScript source.
- `python-worker-sdk` uses pytest-cov with branch coverage for `factory_floor_worker_sdk`.
- `python-demo` uses pytest-cov with branch coverage for `factory_floor_demo_py`.

The repository summary retains the language and package boundaries instead of combining unlike coverage metrics into one percentage.

## Reports

Fast verification retains `.factory-floor/coverage/` for 30 days. It contains:

- TypeScript JSON summary, full JSON, LCOV, Cobertura XML, and HTML reports;
- Python SDK JSON, XML, HTML, and terminal reports;
- Python demo-worker JSON, XML, HTML, and terminal reports;
- `summary.json`, the normalized repository coverage summary.

Missing or malformed expected reports fail verification.

## Included and excluded code

TypeScript coverage explicitly includes executable source under `apps/*/src`, `packages/*/src`, `workers/*/src`, and repository scripts.

Broad exclusions are limited to:

- generated code;
- type-only declarations;
- test files;
- deliberate process entry points whose behavior is exercised through process-level acceptance rather than import-time unit execution.

The current deliberate entry-point exclusions are the control-plane server launcher, console browser bootstrap, and demo TypeScript worker launcher.

## Threshold policy

`quality-gates.json` records future changed-line and changed-branch targets, but `futureCoverageRatchet.enforced` remains `false` for this baseline slice. Later enforcement must be based on representative post-#121 history and cannot silently lower the stored baseline.
