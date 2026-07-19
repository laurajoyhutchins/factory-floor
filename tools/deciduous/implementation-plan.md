# Deciduous Pilot Implementation Plan

> **For agentic workers:** Implement task-by-task with test-first commits. Do not add production runtime dependencies or blocking assistant hooks.

**Goal:** Add a reversible, repository-owned Deciduous pilot for Factory Floor development history.

**Architecture:** A Bash wrapper provides the stable repository interface to an externally installed, pinned Deciduous CLI. Local graph state is ignored while exported JSON patches may be committed. Vitest executes the wrapper against a fake CLI so ordinary CI remains deterministic and offline.

**Tech stack:** Bash, Node.js 22, Vitest, Git ignore rules, Markdown.

## Global constraints

- No Factory Floor runtime behavior, contract, storage, migration, or deployment changes.
- No edit-blocking hooks.
- No automatic Deciduous installation or upgrade.
- Ordinary CI must not require Deciduous or network access.
- ADRs, issues, PRs, and commits retain their existing authority.
- Local Deciduous SQLite state must remain ignored.

---

### Task 1: Executable wrapper specification

**Files:**
- Create: `tests/repository/deciduous-pilot.test.ts`

**Produces:** Executable requirements for prerequisite checks, argument validation, command mapping, and export behavior.

- [ ] Add a temporary fake `deciduous` executable that records argv and returns controlled output.
- [ ] Specify `doctor` behavior for missing executable, matching version, and mismatched version.
- [ ] Specify argument validation for `start`, `decision`, `observe`, `finish`, and `export`.
- [ ] Specify that repository commands map to the intended Deciduous CLI calls.
- [ ] Run the focused test and confirm it fails because `scripts/deciduous-pilot.sh` does not exist.
- [ ] Commit the red specification.

### Task 2: Minimal wrapper implementation

**Files:**
- Create: `scripts/deciduous-pilot.sh`
- Create: `tools/deciduous/VERSION`

**Consumes:** Tests from Task 1.

**Produces:** Stable nonblocking repository interface to Deciduous 0.16.0.

- [ ] Implement strict shell mode, repository-root discovery, version reading, and actionable errors.
- [ ] Implement `doctor`, `init`, `recover`, `start`, `decision`, `observe`, `finish`, and `export`.
- [ ] Never install, update, or invoke a remote service automatically.
- [ ] Run the focused test until green.
- [ ] Run `pnpm verify:fast`.
- [ ] Commit the implementation.

### Task 3: Persistence and agent workflow

**Files:**
- Modify: `.gitignore`
- Modify: `AGENTS.md`
- Create: `.deciduous/patches/.gitkeep`
- Create: `tools/deciduous/README.md`

**Consumes:** Wrapper interface from Task 2.

**Produces:** Documented three-checkpoint workflow and reviewable patch persistence.

- [ ] Ignore all `.deciduous` state except `.deciduous/patches/`, JSON patch files, and `.gitkeep`.
- [ ] Document installation, commands, examples, recording policy, authority boundaries, evaluation, security, and rollback.
- [ ] Add concise nonblocking instructions to `AGENTS.md`.
- [ ] Add structural assertions to the repository test for ignore and instruction invariants.
- [ ] Run the focused test and `pnpm verify:fast`.
- [ ] Commit the workflow and persistence changes.

### Task 4: Review and publication

**Files:**
- Update: issue #57
- Open: draft pull request to `main`

**Produces:** Reviewable pilot with explicit evidence and follow-up tracking.

- [ ] Review the complete diff for accidental runtime or CI coupling.
- [ ] Confirm no generated Claude/OpenCode/Windsurf hooks were added.
- [ ] Run available repository verification and report any environment limitation honestly.
- [ ] Open a draft PR that closes #57 only when implementation and checks are complete.
- [ ] Leave the pilot in draft until CI is green and the decision-graph workflow has been smoke-tested with a real Deciduous installation.
