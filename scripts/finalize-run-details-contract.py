from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"expected source not found in {path}")
    file.write_text(text.replace(old, new, 1))


replace(
    "packages/runtime-core/src/operator/run-details-query-service.ts",
    """      projectionFreshness: {
        staleAfterMs: PROJECTION_STALE_AFTER_MS,
        generatedAt: generatedAt.toISOString(),
        items: checkpoints.map((checkpoint) => {
          const updatedAt = new Date(String(checkpoint.updated_at));
          const stalenessMs = Math.max(
            0,
            generatedAt.getTime() - updatedAt.getTime(),
          );
          return {
            id: checkpoint.id,
            projectionName: checkpoint.projection_name,
            streamKey: checkpoint.stream_key,
            lastEventId: checkpoint.last_event_id,
            lastSequenceNumber: checkpoint.last_sequence_number,
            updatedAt: checkpoint.updated_at,
            stalenessMs,
            stale:
              !Number.isFinite(stalenessMs) ||
              stalenessMs > PROJECTION_STALE_AFTER_MS,
          };
        }),
      },
""",
    """      projectionFreshness: {
        scope: 'control_plane_global' as const,
        staleAfterMs: PROJECTION_STALE_AFTER_MS,
        generatedAt: generatedAt.toISOString(),
        items: checkpoints.map((checkpoint) => {
          const updatedAt = new Date(String(checkpoint.updated_at));
          const stalenessMs = Math.max(
            0,
            generatedAt.getTime() - updatedAt.getTime(),
          );
          return {
            projectionName: checkpoint.projection_name,
            updatedAt: checkpoint.updated_at,
            stalenessMs,
            stale:
              !Number.isFinite(stalenessMs) ||
              stalenessMs > PROJECTION_STALE_AFTER_MS,
          };
        }),
      },
""",
)

replace(
    "packages/operator-client-ts/src/run-details.ts",
    """export interface RunProjectionFreshnessDetail {
  id: string;
  projectionName: string;
  streamKey: string;
  lastEventId: string | null;
  lastSequenceNumber: string;
  updatedAt: string;
  stalenessMs: number;
  stale: boolean;
}
""",
    """export interface RunProjectionFreshnessDetail {
  projectionName: string;
  updatedAt: string;
  stalenessMs: number;
  stale: boolean;
}
""",
)
replace(
    "packages/operator-client-ts/src/run-details.ts",
    """  projectionFreshness: {
    staleAfterMs: number;
""",
    """  projectionFreshness: {
    scope: 'control_plane_global';
    staleAfterMs: number;
""",
)
replace(
    "packages/operator-client-ts/src/run-details.ts",
    """    !isRecord(value.projectionFreshness) ||
    !Array.isArray(value.projectionFreshness.items)
""",
    """    !isRecord(value.projectionFreshness) ||
    value.projectionFreshness.scope !== 'control_plane_global' ||
    !Array.isArray(value.projectionFreshness.items)
""",
)

replace(
    "packages/operator-client-ts/src/run-details.test.ts",
    """        projection_freshness: {
          stale_after_ms: 60000,
""",
    """        projection_freshness: {
          scope: 'control_plane_global',
          stale_after_ms: 60000,
""",
)
replace(
    "packages/operator-client-ts/src/run-details.test.ts",
    """    expect(result.projectionFreshness.staleAfterMs).toBe(60000);
""",
    """    expect(result.projectionFreshness).toMatchObject({
      scope: 'control_plane_global',
      staleAfterMs: 60000,
    });
""",
)

replace(
    "packages/operator-ui-react/src/pages/run-details.tsx",
    """                 artifact derivations, and projection freshness.
""",
    """                 artifact derivations, and aggregate control-plane projection freshness.
""",
)
replace(
    "packages/operator-ui-react/src/pages/run-details.tsx",
    """            title="Projection freshness"
            empty="No projection checkpoints are available."
            headers=[
""" if False else """            title="Projection freshness"
            empty="No projection checkpoints are available."
            headers={[
              'Projection',
              'Checkpoint',
              'Sequence',
              'Freshness',
              'Updated',
            ]}
            rows={details.projectionFreshness.items.map((projection) => [
              <span key="projection">{projection.projectionName}</span>,
              <CopyId key="checkpoint" value={projection.id} />,
              <span key="sequence">{projection.lastSequenceNumber}</span>,
              <StatusBadge
                key="freshness"
                value={projection.stale ? 'stale' : 'fresh'}
              />,
              <Timestamp key="updated" value={projection.updatedAt} />,
            ])}
""",
    """            title="Control-plane projection freshness"
            empty="No control-plane projection checkpoints are available."
            headers={['Projection', 'Freshness', 'Updated']}
            rows={details.projectionFreshness.items.map((projection) => [
              <span key="projection">{projection.projectionName}</span>,
              <StatusBadge
                key="freshness"
                value={projection.stale ? 'stale' : 'fresh'}
              />,
              <Timestamp key="updated" value={projection.updatedAt} />,
            ])}
""",
)

replace(
    "packages/operator-ui-react/src/pages/run-details.test.tsx",
    """      projectionFreshness: {
        staleAfterMs: 60000,
""",
    """      projectionFreshness: {
        scope: 'control_plane_global' as const,
        staleAfterMs: 60000,
""",
)
replace(
    "packages/operator-ui-react/src/pages/run-details.test.tsx",
    """          {
            id: 'checkpoint-1',
            projectionName: 'run_status',
            streamKey: 'global',
            lastEventId: null,
            lastSequenceNumber: '12',
            updatedAt: '2026-07-20T00:00:00.000Z',
""",
    """          {
            projectionName: 'run_status',
            updatedAt: '2026-07-20T00:00:00.000Z',
""",
)

replace(
    "tests/integration/runtime-core/run-details-query-service.test.ts",
    """      modifications: [],
""",
    """      modifications: {},
""",
)
replace(
    "tests/integration/runtime-core/run-details-query-service.test.ts",
    """    expect(details.projectionFreshness.items).toEqual([
      expect.objectContaining({ projectionName: 'run_status', stale: true }),
    ]);

    const serialized = JSON.stringify(details);
""",
    """    expect(details.projectionFreshness.scope).toBe('control_plane_global');
    expect(details.projectionFreshness.items).toEqual([
      expect.objectContaining({ projectionName: 'run_status', stale: true }),
    ]);
    expect(details.projectionFreshness.items[0]).not.toHaveProperty('id');
    expect(details.projectionFreshness.items[0]).not.toHaveProperty('streamKey');
    expect(details.projectionFreshness.items[0]).not.toHaveProperty('lastEventId');
    expect(details.projectionFreshness.items[0]).not.toHaveProperty(
      'lastSequenceNumber',
    );

    const serialized = JSON.stringify(details);
""",
)

Path(".github/workflows/finalize-run-details-contract.yml").unlink(missing_ok=True)
Path("scripts/finalize-run-details-contract.py").unlink(missing_ok=True)
