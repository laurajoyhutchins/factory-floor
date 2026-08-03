# Deciduous backfills

Factory Floor archaeology uses a frozen reviewed base export plus ordered readable patches.

## Canonical source

The current canonical source is the combination of:

1. `.deciduous/exports/factory-floor-archaeology.json`, the frozen 52-node/52-edge base reviewed in PR #146;
2. ordered patch files under `tools/deciduous/backfill/patches/`.

The base export is no longer described as a complete current-tree snapshot by itself. It is the immutable starting coordinate for later corrections. Each patch records the exact repository head, evidence paths, lifecycle, and causal links needed to reconcile subsequent default-branch changes.

`materialize_current.py` produces a deterministic normalized current graph from the base and patches. The flattened current file is generated on demand rather than committed:

```bash
python tools/deciduous/backfill/materialize_current.py \
  --output .deciduous/exports/factory-floor-archaeology-current.json
python tools/deciduous/backfill/validate_current.py
```

## Authority boundary

Repository records remain authoritative for implementation and accepted architecture. The graph records consequential causal history and does not replace issues, ADRs, commits, tests, release evidence, or live runtime state.

A materialized graph proves structural reconciliation only. It does not prove a live Portfolio Control Plane integration, deployment configuration, external convergence, or production readiness.

## Current reconciliation

The first patch reconciles commit `c377a86f0a1c4bec04e6e5c4f0f0578995d9f46b`, which added a separate read-only Portfolio Control Plane client and reusable operator view. The relationship is deliberately narrow:

- Portfolio Control Plane remains authoritative for source-neutral coordination projections;
- Factory Floor remains authoritative for its own runtime and event state;
- the browser surface does not claim work, record outcomes, reconcile sources, or execute portfolio work;
- the tested read surface is not represented as a universal portfolio-to-execution integration.

The original evidence ledger remains `factory-floor-archaeology.md`.
