# Measurable CI Quality Gates Design

## Status

Approved for implementation by the repository owner on July 18, 2026. Tracks #55.

## Goal

Preserve Factory Floor's complete pull-request verification while making its duration, outcomes, test counts, and workflow policy machine-readable and enforceable.

## Design principles

1. **Do not weaken the existing gate.** Static, unit, Docker-backed integration, live-restart acceptance, and clean-checkout acceptance continue to run on every pull request.
2. **Measure before ratcheting.** This change records trustworthy stage and test metrics. Changed-line coverage and rolling p95 enforcement follow after enough baseline runs exist.
3. **Keep local and CI commands aligned.** Canonical `pnpm verify:*` commands remain authoritative. CI wraps them only to record metadata.
4. **Fail closed on workflow drift.** A repository-owned checker validates quality-gate configuration, required stage wiring, immutable action references, and metrics retention.
5. **Use only existing runtime dependencies.** The first slice uses Node.js built-ins, Vitest's bundled JUnit reporter, and pytest's bundled JUnit output.

## Components

### `quality-gates.json`

A versioned policy document containing:

- target fast and complete verification p95 durations;
- maximum acceptable flaky-rerun rate;
- future changed-line and changed-branch coverage targets;
- oversized-change review thresholds;
- required CI jobs and canonical stages;
- the immutable-action requirement.

Coverage values are recorded as the next ratchet, not enforced in this slice.

### Stage metrics wrapper

`scripts/run-ci-stage.mjs` executes one canonical command and always writes a JSON record containing:

- stage name and command;
- UTC start and completion timestamps;
- duration in milliseconds and seconds;
- exit code, signal, and success state;
- GitHub run, attempt, job, event, ref, and commit identities when available.

It returns the wrapped command's exit status.

### Test result reporting

CI-specific package scripts run:

- Vitest with default and JUnit reporters;
- each Python pytest project with its own JUnit XML file.

Local `pnpm test` and `pnpm test:python` behavior remains unchanged. `scripts/verify.sh` selects CI reporters only when `CI=true`.

### Metrics summary

`scripts/summarize-ci-metrics.mjs` reads stage JSON and JUnit XML files, writes an aggregate JSON summary, and emits a Markdown table suitable for `$GITHUB_STEP_SUMMARY`. It tolerates absent test files so failure-path diagnostics can still be retained.

### Workflow policy checker

`scripts/check-ci-quality-gates.mjs` validates:

- the quality-gate document's schema and numeric ranges;
- all required jobs and canonical stages are present;
- every external `uses:` reference is pinned to a 40-character hexadecimal commit SHA;
- every verification job records metrics and uploads the metric directory;
- the clean acceptance job remains dependent on Docker-backed verification.

The checker runs inside `verify:static`, so CI cannot silently remove its own controls.

### Pull request template

The template requires a contributor or agent to state:

- risk classification;
- affected invariants;
- durable-state and transaction effects;
- contract, schema, and migration effects;
- retry, replay, idempotency, and failure behavior;
- compatibility and rollback strategy;
- exact verification evidence.

## Error handling

- Metrics files are written in a `finally` path after command completion or spawn failure.
- Failure to write required metrics is itself a failing condition.
- Test summaries preserve failures and errors rather than converting them to success.
- Workflow policy validation reports every discovered violation in one run.

## Testing

Repository tests cover:

- successful and failing wrapped commands;
- metric metadata and exit-status preservation;
- JUnit aggregation;
- invalid quality-gate documents;
- rejection of floating action tags;
- required workflow stage and artifact wiring;
- structural preservation of the existing canonical verification stages.

The final pull request must pass the complete Repository Verification workflow and clean-checkout Milestone 1 acceptance.