# Deciduous boundary

Factory Floor treats Deciduous as optional, nonblocking development-history tooling. The committed material under `.deciduous/exports/` is frozen pilot/archaeology evidence, not active graph state and not a recovery source.

When this repository's active maintained Deciduous surface is used:

1. Use the approved stock `deciduous` CLI directly.
2. If the executable is absent, hydrate and verify the pinned approved Deciduous artifact through the existing artifact contract.
3. When `.deciduous/sync/` exists, run `deciduous events status`. If the local database is absent or shared events are pending, preview `deciduous events rebuild --dry-run`, run `deciduous events rebuild` when the preview is sound, and inspect `deciduous pulse` before relying on graph context.
4. Use native Deciduous commands during repository work.
5. Include material native `.deciduous/sync/` changes in the same repository candidate as the consequential change that caused them.
6. Never implement or invoke a repository-specific Deciduous wrapper, shadow schema, parser, synchronization format, validator, database interface, graph-hygiene layer, or recovery protocol.
7. If native Deciduous or the maintained graph state is unavailable, do not emulate it. Continue ordinary Factory Floor work unless the selected gate explicitly requires Deciduous itself.

Do not run `deciduous events init` merely because `.deciduous/sync/` is absent. A first shared checkpoint must originate from the actual maintained native graph. Never manufacture current state from `.deciduous/exports/` or `tools/deciduous/backfill/`.

GitHub issues, ADRs, pull requests, commits, and repository verification remain the authoritative Factory Floor surfaces described by `AGENTS.md`. Deciduous is a compatibility surface, not a Factory Floor runtime dependency or authority store.
