# Deciduous Pilot Design

**Status:** Approved for implementation

**Tracking issue:** #57

## Purpose

Factory Floor will run a contained Deciduous pilot to determine whether a lightweight decision graph improves context recovery, review quality, and continuity across AI-assisted development sessions.

The pilot is development tooling only. It does not change Factory Floor runtime behavior, contracts, storage, deployment, or architecture.

## Authority boundaries

- GitHub issues remain authoritative for proposed work and acceptance criteria.
- ADRs remain authoritative for accepted architecture.
- Pull requests and commits remain authoritative for implemented changes and verification.
- Deciduous records options, reasoning, observations, pivots, and outcomes.

Deciduous must not become a second issue tracker, a replacement for ADRs, or a runtime graph inside Factory Floor.

## Selected approach

Use a repository-owned, nonblocking integration rather than generated assistant hooks or an immediately hosted central daemon.

The pilot must:

- avoid pre-edit blocking hooks;
- avoid production dependencies and database migrations;
- avoid requiring Deciduous or network access in ordinary CI;
- keep local SQLite state ignored;
- permit reviewable full-graph JSON snapshots to be committed;
- require only three workflow checkpoints: task start or resume, consequential decision or pivot, and final outcome with commit or PR linkage.

## Components

### Operating guide

`tools/deciduous/README.md` defines installation, the three-checkpoint workflow, examples, authority boundaries, evaluation, and rollback.

### Version pin

`tools/deciduous/VERSION` records the reviewed Deciduous version. The wrapper reports version mismatch but does not silently upgrade the executable.

### Wrapper

`scripts/deciduous-pilot.sh` provides a stable repository interface:

- `doctor`
- `init`
- `recover`
- `start`
- `decision`
- `observe`
- `finish`
- `export`

The wrapper validates prerequisites and arguments, invokes the external CLI, and keeps repository conventions out of ad hoc agent prompts.

### Persistence

`.deciduous/deciduous.db` and other local state remain ignored. `.deciduous/exports/*.json` may be committed when the graph contains meaningful decision history that must survive ephemeral workspaces.

The pinned Deciduous 0.16.0 CLI exposes `graph` but does not expose the `diff export` command still described by some upstream documentation. The repository wrapper therefore captures the supported full graph output, validates it as JSON, and atomically publishes the snapshot. Branch metadata remains embedded in graph nodes.

Phase one does not deploy the Deciduous HTTP daemon. Central persistence may be considered only after the pilot demonstrates value and its security model is separately reviewed.

### Agent instructions

`AGENTS.md` gains a concise, nonblocking pilot section. Agents should not log routine edits, formatting, ordinary test reruns, secrets, credentials, or raw hidden reasoning.

### Tests

Repository tests use a fake `deciduous` executable. CI must verify wrapper behavior without installing Deciduous or accessing the network.

## Error handling

The wrapper must fail with actionable messages when:

- the executable is absent;
- the installed version differs from the reviewed version;
- required arguments are missing;
- the repository has not been initialized;
- an export filename is invalid;
- Deciduous emits an invalid JSON graph snapshot.

`doctor` may report an absent or mismatched executable without modifying repository state. No command may install or upgrade Deciduous automatically.

## Evaluation

Run the pilot for 10 substantial PRs or 30 days, whichever comes later.

Success requires:

- at least 8 of 10 qualifying PRs with a useful complete chain;
- graph context reused in at least three later sessions;
- at least two recorded decisions or pivots that materially improve review, recovery, or later design work;
- median logging overhead under five minutes per PR;
- no production behavior, CI availability, or ordinary edit depending on Deciduous;
- meaningful rationale rather than duplicated issue or PR text.

The exit decision is one of: retain as-is, retain with central persistence, narrow the workflow, or remove the pilot.

## Rollback

Remove the wrapper, operating guide, version pin, tests, agent instructions, graph snapshots, and local pilot state. No product migration or runtime cleanup is permitted or required.
