# Measurable CI Quality Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add machine-readable CI stage and test metrics, repository-owned workflow policy checks, immutable action references, and a change-risk pull request template without weakening Factory Floor's existing full pull-request verification.

**Architecture:** Canonical `pnpm verify:*` commands remain unchanged as the execution boundary. Small Node.js scripts wrap those commands, validate workflow policy, and aggregate JSON/JUnit evidence. GitHub Actions calls the wrappers and uploads evidence on every outcome.

**Tech Stack:** Node.js 22 built-ins, Vitest 3.2, pytest, YAML, GitHub Actions, Bash.

## Global Constraints

- Preserve static, unit, Docker-backed integration, live-restart, and clean-checkout acceptance on every pull request.
- Add no new production dependency.
- Keep local `pnpm test` and `pnpm test:python` output unchanged.
- Pin every third-party Action to a full 40-character commit SHA.
- Write diagnostic artifacts even when a wrapped command fails.

---

### Task 1: Add failing CI policy and metrics tests

**Files:**

- Create: `scripts/ci-quality.test.mjs`
- Modify: `scripts/verification.test.mjs`

**Interfaces:**

- Consumes: repository files and Node.js process spawning.
- Produces: executable expectations for `run-ci-stage.mjs`, `summarize-ci-metrics.mjs`, `check-ci-quality-gates.mjs`, `quality-gates.json`, and workflow wiring.

- [ ] **Step 1: Write tests for successful and failing stage wrappers**

Spawn `node scripts/run-ci-stage.mjs --stage fixture --output <temp>/fixture.json -- node -e <program>` and assert the JSON fields and preserved exit status.

- [ ] **Step 2: Write a JUnit aggregation test**

Create temporary Vitest- and pytest-shaped XML files, run the summarizer, and assert totals for tests, failures, errors, skipped tests, and duration.

- [ ] **Step 3: Write workflow policy tests**

Assert that all workflow `uses:` values match `/^[^@]+@[0-9a-f]{40}$/`, required stages use the wrapper, and every verification job uploads `.factory-floor/ci-metrics/`.

- [ ] **Step 4: Run the focused test and verify RED**

Run: `pnpm test -- scripts/ci-quality.test.mjs scripts/verification.test.mjs`

Expected: failure because the new scripts, policy file, pinned actions, and workflow wiring do not exist yet.

- [ ] **Step 5: Commit the failing tests**

```bash
git add scripts/ci-quality.test.mjs scripts/verification.test.mjs
git commit -m "test: specify measurable CI quality gates"
```

### Task 2: Implement repository-owned quality policy

**Files:**

- Create: `quality-gates.json`
- Create: `scripts/check-ci-quality-gates.mjs`
- Modify: `package.json`
- Modify: `scripts/verify.sh`

**Interfaces:**

- Consumes: `quality-gates.json` and `.github/workflows/repository-verification.yml`.
- Produces: `pnpm ci:quality:check`, exiting nonzero with all policy violations.

- [ ] **Step 1: Add the versioned policy file**

Record required jobs/stages, duration targets, future coverage targets, change-size review thresholds, and immutable action enforcement.

- [ ] **Step 2: Implement validation**

Use `node:fs`, `node:path`, and `yaml` to validate numeric ranges, required jobs, canonical wrapped stages, action SHA pins, metrics uploads, and the `m1-acceptance` dependency.

- [ ] **Step 3: Wire policy validation into static verification**

Add `"ci:quality:check": "node scripts/check-ci-quality-gates.mjs"` and run it before lint/typecheck in `verify_static()`.

- [ ] **Step 4: Run focused tests and verify GREEN for policy checks**

Run: `pnpm test -- scripts/ci-quality.test.mjs scripts/verification.test.mjs`

Expected: remaining failures are limited to the not-yet-implemented wrapper, summarizer, and workflow changes.

- [ ] **Step 5: Commit**

```bash
git add quality-gates.json scripts/check-ci-quality-gates.mjs package.json scripts/verify.sh
git commit -m "chore: enforce repository CI quality policy"
```

### Task 3: Record stage and test metrics

**Files:**

- Create: `scripts/run-ci-stage.mjs`
- Create: `scripts/summarize-ci-metrics.mjs`
- Modify: `package.json`
- Modify: `scripts/verify.sh`

**Interfaces:**

- `run-ci-stage.mjs --stage <name> --output <path> -- <command...>` writes one metric and returns the command status.
- `summarize-ci-metrics.mjs --metrics <dir> --tests <dir> --output <path>` writes aggregate JSON and Markdown to stdout.

- [ ] **Step 1: Implement the stage wrapper**

Use `spawnSync` with inherited stdio, UTC timestamps, `performance.now()`, and an unconditional JSON write before returning the wrapped status.

- [ ] **Step 2: Implement JUnit and stage aggregation**

Read metric JSON files recursively, extract root `<testsuites>` or `<testsuite>` attributes from XML, sum results, write aggregate JSON, and print a Markdown summary.

- [ ] **Step 3: Add CI-specific test scripts**

Add `test:ci` with Vitest default and JUnit reporters and `test:python:ci` with separate pytest JUnit files. In `verify_unit()`, select them only when `CI=true`.

- [ ] **Step 4: Run focused tests**

Run: `pnpm test -- scripts/ci-quality.test.mjs scripts/verification.test.mjs`

Expected: all script-level tests pass; workflow structural tests remain red.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-ci-stage.mjs scripts/summarize-ci-metrics.mjs package.json scripts/verify.sh
git commit -m "feat: record CI stage and test metrics"
```

### Task 4: Harden Repository Verification workflow

**Files:**

- Modify: `.github/workflows/repository-verification.yml`

**Interfaces:**

- Consumes: canonical `pnpm verify:*` commands and metrics scripts.
- Produces: pinned Actions, per-stage JSON, JUnit artifacts, aggregate summaries, and unchanged required jobs.

- [ ] **Step 1: Pin all Actions**

Replace floating major tags with the reviewed full SHAs for checkout, setup-node, setup-python, and upload-artifact.

- [ ] **Step 2: Wrap every canonical stage**

Use `node scripts/run-ci-stage.mjs` for static, unit, services, integration, acceptance, and clean acceptance commands.

- [ ] **Step 3: Summarize and upload evidence on every outcome**

Add `if: always()` steps to aggregate metrics into `$GITHUB_STEP_SUMMARY` and upload `.factory-floor/ci-metrics/` plus `.factory-floor/test-results/`.

- [ ] **Step 4: Run focused structural tests**

Run: `pnpm test -- scripts/ci-quality.test.mjs scripts/verification.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/repository-verification.yml
git commit -m "ci: publish measured immutable verification"
```

### Task 5: Add change-assurance guidance

**Files:**

- Create: `.github/pull_request_template.md`
- Modify: `docs/how-to/development-environment.md`

**Interfaces:**

- Produces: explicit PR risk/invariant declarations and documented local/CI commands and artifacts.

- [ ] **Step 1: Add the PR template**

Require summary, risk, invariant impact, durable-state/transaction effects, contracts/migrations, failure semantics, compatibility/rollback, and exact verification evidence.

- [ ] **Step 2: Document metrics and policy commands**

Explain `pnpm ci:quality:check`, CI-only JUnit behavior, metric artifact paths, and the policy for future coverage ratchets.

- [ ] **Step 3: Run documentation and repository formatting checks**

Run: `pnpm format:check`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .github/pull_request_template.md docs/how-to/development-environment.md
git commit -m "docs: require change-assurance evidence"
```

### Task 6: Complete verification and publish the PR

**Files:**

- Review all changed files.

- [ ] **Step 1: Run fast verification**

Run: `pnpm verify:fast`

Expected: PASS with policy, static, TypeScript, Python, console build, and formatting checks green.

- [ ] **Step 2: Open a draft pull request**

Use title `ci: add measurable change-assurance gates`, reference `Closes #55`, and describe preserved gates and deferred coverage ratcheting.

- [ ] **Step 3: Observe full GitHub Actions verification**

Required jobs: Fast repository verification, Docker-backed repository verification, and Milestone 1 clean acceptance.

- [ ] **Step 4: Inspect retained metrics and test artifacts**

Confirm each job uploads stage metrics; unit verification includes Vitest and Python JUnit XML; the clean acceptance evidence remains present.

- [ ] **Step 5: Address any failures and re-run the complete workflow**

Do not mark ready until the reviewed head has a successful full Repository Verification run.
