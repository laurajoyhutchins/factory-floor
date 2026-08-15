# Deciduous

Factory Floor uses Deciduous as non-normative, repository-local causal history. GitHub issues, ADRs, code, tests, pull requests, and commits remain authoritative for their respective concerns.

The reviewed release is **Deciduous 0.16.0**, recorded in `VERSION`. As of 2026-08-15, 0.16.0 is still the current upstream release, so this refresh does not change the pin.

## Use the upstream interface directly

Do not create or restore a Factory Floor wrapper around Deciduous. Invoke the installed `deciduous` CLI, MCP surface, or current upstream skill directly.

```bash
deciduous --version
deciduous --help
deciduous nodes
deciduous context
```

For mutations, use the commands supported by the installed release, such as `add` and `link`, rather than a repository-authored proxy that translates Factory Floor vocabulary into Deciduous commands.

The repository must not:

- shadow native Deciduous commands with aliases or wrapper scripts;
- maintain a second Deciduous schema or compatibility API;
- install or upgrade Deciduous implicitly during ordinary Factory Floor work;
- require Deciduous for runtime correctness or normal repository verification;
- centralize other repositories' causal histories into Factory Floor's graph.

See `.deciduous/README.md` for the repository-local authority and persistence boundary.

## Version and offline availability

`VERSION` records the reviewed upstream release. The retained offline Deciduous capsule is owned by the `offline-execution` repository, which is the appropriate place for binary hydration, hashes, and cold-room verification. Factory Floor does not duplicate that supply-chain machinery.

If Deciduous is unavailable in a working environment, continue the repository task and report that causal-history materialization was unavailable. Do not substitute a home-grown implementation.

## Historical material

The August 2 archaeology work is retained as evidence:

- `.deciduous/exports/factory-floor-archaeology.json` is the native historical export produced during the original backfill;
- `backfill/factory-floor-archaeology.md` records the evidence used to reconstruct that history;
- `backfill/validation.json` records the original validation receipt.

Those files are historical snapshots, not a promise that the export is continuously synchronized.

`backfill/2026-08-03-through-2026-08-14.md` records the consequential continuation after that snapshot. It is deliberately evidence for native Deciduous materialization, not a hand-authored replacement for Deciduous producer output.

## Recording policy

Record only causal information that will help later recovery or review: goals, consequential alternatives, decisions, observations, revisits, implemented actions, and verified outcomes. Link nodes to the repository evidence that supports them when practical.

Do not record routine edits, formatting, repeated test commands, speculative history as fact, secrets, private environment values, customer data, or hidden chain-of-thought.
