# Deciduous backfills

Historical causal backfills live here as repository-evidence ledgers. Native Deciduous producer output may be committed under `.deciduous/exports/` when it has actually been materialized and reviewed.

Backfills must follow the repository's Deciduous authority boundaries: repository records remain authoritative, unsupported explanations are omitted, and causal history captures consequential model changes rather than every commit.

Current material:

- `factory-floor-archaeology.md` pairs with the native historical snapshot `.deciduous/exports/factory-floor-archaeology.json` and covers the recovered history through 2026-08-02.
- `2026-08-03-through-2026-08-14.md` records reviewed post-snapshot causal evidence for later materialization through native Deciduous.
- `validation.json` is the receipt for the original archaeology backfill.

Do not hand-author or patch a JSON file under `.deciduous/exports/` and describe it as Deciduous output. If the native tool is unavailable, keep reviewed evidence here and materialize it later through the upstream interface.
