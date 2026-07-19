# Deciduous pilot

Factory Floor is piloting Deciduous as non-normative development-history tooling. The pilot records why AI-assisted work evolved without changing Factory Floor runtime behavior or replacing existing project records.

See issue #57 for evaluation tracking and `pilot-design.md` for the approved design.

## Authority boundaries

- GitHub issues define proposed work and acceptance criteria.
- ADRs define accepted architecture.
- Pull requests and commits define implemented changes and verification.
- Deciduous records options, decisions, observations, pivots, and outcomes.

When records disagree, the existing authoritative source wins. Deciduous is not a second issue tracker, an ADR replacement, or a Factory Floor runtime graph.

## Install the reviewed version

The pilot is pinned to **Deciduous 0.16.0** in `tools/deciduous/VERSION`.

One installation path is:

```bash
cargo install deciduous --version 0.16.0 --locked
```

A reviewed prebuilt release binary may also be used. The repository wrapper never installs or upgrades Deciduous automatically.

Verify the executable before use:

```bash
bash scripts/deciduous-pilot.sh doctor
```

A missing or different version is reported clearly. Because this is optional pilot tooling, its absence must not block ordinary Factory Floor work.

## Initialize local state

Use the repository wrapper, not upstream `deciduous init`:

```bash
bash scripts/deciduous-pilot.sh init
```

The wrapper creates `.deciduous/` state and initializes the SQLite database by running a read-only graph command. It does not generate `.claude`, `.opencode`, or `.windsurf` files and does not install hooks.

Local state includes:

- `.deciduous/deciduous.db` — local graph database;
- `.deciduous/current-node` — pointer used to link the active pilot chain;
- `.deciduous/documents/` — optional local attachments;
- `.deciduous/exports/` — reviewable full-graph JSON snapshots.

Everything under `.deciduous/` is ignored except `.deciduous/exports/.gitkeep` and JSON graph snapshots.

## Three-checkpoint workflow

Use the wrapper only for consequential development history. A typical task has three required checkpoints plus optional observations.

### 1. Start or resume the goal

```bash
bash scripts/deciduous-pilot.sh start "Implement issue #57"
```

This starts a new linked chain. To inspect existing context after a session boundary:

```bash
bash scripts/deciduous-pilot.sh recover
```

### 2. Record meaningful decisions and discoveries

```bash
bash scripts/deciduous-pilot.sh decision \
  "Use a repository-owned nonblocking wrapper" \
  "Generated assistant hooks would interfere with Factory Floor's existing workflow"

bash scripts/deciduous-pilot.sh observe \
  "Root Vitest excludes tests/** and discovers scripts/**/*.test.mjs"
```

Each node is linked to the previous node in the active chain. Record another decision or observation only when it will help later recovery, review, or design work.

### 3. Finish with the verified outcome

```bash
bash scripts/deciduous-pilot.sh finish \
  "Pilot wrapper and policy checks pass repository verification" \
  HEAD
```

Finishing records the outcome, links it to the chain, associates the commit, and clears the active-chain pointer.

### Export a durable snapshot

When the graph contains useful history that should survive an ephemeral workspace:

```bash
bash scripts/deciduous-pilot.sh export "agent-deciduous-pilot.json"
```

The filename must be a simple `.json` filename. The wrapper uses the supported `deciduous graph` command, validates the JSON, and atomically writes the snapshot under `.deciduous/exports/`. Some upstream 0.16.0 documentation still mentions `diff export`, but that command is not exposed by the released CLI. Review the snapshot before committing it. Do not export empty, routine, or duplicative histories merely to satisfy a checkbox.

## Command reference

| Command                     | Purpose                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `doctor`                    | Verify that the reviewed executable version is available.           |
| `init`                      | Create local graph state without generated assistant integration.   |
| `recover`                   | Show nodes, edges, and recent commands for context recovery.        |
| `start <goal>`              | Start a new goal chain.                                             |
| `decision <title> <reason>` | Add and link a consequential decision.                              |
| `observe <observation>`     | Add and link a discovery or constraint.                             |
| `finish <outcome> [commit]` | Add the linked outcome and close the active chain.                  |
| `export <file.json>`        | Export a validated full-graph snapshot under `.deciduous/exports/`. |

Run all commands as `bash scripts/deciduous-pilot.sh <command> ...`.

## Recording policy

Record:

- the task goal;
- genuinely viable alternatives or consequential choices;
- why an approach was selected or rejected;
- discoveries that changed or clarified the plan;
- pivots and superseded approaches;
- the verified outcome and associated commit or pull request.

Do not record:

- routine edits, formatting, or repeated test commands;
- text copied from an issue or pull request without additional rationale;
- speculative machine-generated history presented as fact;
- hidden chain-of-thought or private scratch reasoning;
- credentials, tokens, private environment values, customer data, or sensitive attachments.

**Never record secrets.** Deciduous snapshot files are reviewable repository content and must be treated accordingly.

## CI and failure behavior

Ordinary CI does not install Deciduous and does not access the network for this pilot. Vitest uses a fake executable to verify wrapper behavior.

The wrapper fails before mutation when:

- Deciduous is absent or its version differs from `VERSION`;
- a required argument is missing;
- a decision, observation, or outcome is attempted without an active chain;
- an export filename contains path separators or is not JSON.

A Deciduous failure does not relax Factory Floor's normal verification requirements.

## Security and central persistence

Phase one is local-only. Do not configure the Deciduous HTTP daemon, public endpoints, shared bearer tokens, or background synchronization as part of this pilot.

Central persistence requires a separate review of authentication scope, graph isolation, query exposure, rate limiting, backup, restore, and secret handling. It may be considered only after the workflow demonstrates measurable value.

## Evaluation

Run the pilot for **10 substantial pull requests or 30 days**, whichever comes later.

Success requires:

- at least 8 of 10 qualifying pull requests with a useful complete chain;
- prior graph context reused in at least three later sessions;
- at least two decisions or pivots that materially improve review, recovery, or later design work;
- median logging overhead below five minutes per pull request;
- no production behavior, CI availability, or ordinary edit depending on Deciduous;
- meaningful rationale rather than duplicated issue and pull request text.

Issue #57 tracks observations and the final decision: retain as-is, retain with separately reviewed central persistence, narrow the workflow, or remove it.

## Rollback

Remove:

- `scripts/deciduous-pilot.sh` and its tests;
- this directory and the version pin;
- the Deciduous section in `AGENTS.md`;
- the `.deciduous` exceptions in `.gitignore`;
- committed pilot graph snapshots and local `.deciduous` state.

No Factory Floor migration, runtime cleanup, deployment change, or data conversion is required.
