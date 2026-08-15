# Factory Floor Deciduous state

This directory is repository-local Deciduous development history. It records causal context for consequential Factory Floor work. It is not an issue tracker, ADR store, runtime graph, portfolio graph, or source of current implementation truth.

## Authority

When sources disagree:

1. repository code and tests establish implemented behavior;
2. ADRs establish accepted architecture;
3. GitHub issues and pull requests establish scoped work, review, and delivery history;
4. Deciduous explains causal development history.

Deciduous may point to those authorities. It does not replace them.

## Native interface

Use upstream Deciduous directly. Do not add repository-owned command proxies, aliases, wrapper CLIs, shadow schemas, or synchronization services around it.

The reviewed release is recorded in `tools/deciduous/VERSION`. Use the installed `deciduous` CLI, MCP surface, or current upstream skill as intended by Deciduous itself.

Typical repository-local operations are:

```bash
deciduous --version
deciduous nodes
deciduous context
deciduous add decision "..."
deciduous link <from> <to>
deciduous graph
```

Consult `deciduous --help` for the installed release instead of relying on repository-authored command emulation.

## Persistence

The committed JSON under `.deciduous/exports/` is reviewable historical output. `factory-floor-archaeology.json` captures the recovered history through 2026-08-02 and must not be interpreted as a live projection of every later repository change.

Post-snapshot causal evidence is maintained under `tools/deciduous/backfill/` until it is materialized through native Deciduous. Do not hand-edit a file in `.deciduous/exports/` and present it as producer output.

## Recording boundary

Record decisions, observations, revisits, actions, and outcomes only when they materially explain why the repository changed. Do not record routine edits, repeated verification commands, secrets, credentials, private environment values, or hidden chain-of-thought.

Factory Floor keeps Deciduous repo-local. Cross-repository portfolio state belongs in the portfolio systems that own it, not in a centralized Deciduous graph.
