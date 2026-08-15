# Deciduous historical evidence

Factory Floor uses Deciduous through upstream native interfaces only. Current agent instructions and authority boundaries live in `AGENTS.md`. This directory does not define a Factory Floor command dialect, installation path, version pin, schema, recovery protocol, or active Deciduous state.

## Preserved pilot evidence

Issue #57 records the historical Deciduous pilot and the later decision to replace repository-specific wrapper behavior with native upstream usage.

The material under `backfill/` is retained as frozen, reviewable archaeology from that pilot. The corresponding committed graph snapshot is `.deciduous/exports/factory-floor-archaeology.json`.

These files are evidence about how Factory Floor evolved. They are not:

- an alternate Deciduous implementation;
- current Deciduous storage;
- a recovery source for live native Deciduous state;
- a command or integration contract;
- an authority over GitHub issues, ADRs, pull requests, commits, or repository source.

Do not update these artifacts during ordinary repository work merely to synchronize them with current Deciduous state. Git history preserves the retired wrapper, its tests, its version pin, and the original pilot design when archaeology requires them.

## Active usage

Use the upstream Deciduous CLI, MCP server, installed skills, hooks, and supported native integrations directly. Keep Deciduous optional and nonblocking. If upstream behavior is missing or incorrect, surface or fix the upstream limitation instead of rebuilding it inside Factory Floor.
