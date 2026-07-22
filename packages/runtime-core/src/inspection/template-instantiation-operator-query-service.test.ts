import { describe, expect, it } from 'vitest';
import { projectControlPlaneGlobalFreshness } from './template-instantiation-operator-query-service.js';

describe('aggregate projection freshness', () => {
  it('preserves aggregate health without adding run identity or checkpoint progress', () => {
    const updatedAt = new Date('2026-07-21T19:58:00.000Z');
    const result = projectControlPlaneGlobalFreshness({
      scope: 'control_plane_global',
      staleAfterMs: 60_000,
      generatedAt: '2026-07-21T20:00:00.000Z',
      items: [
        {
          projectionName: 'run_status',
          updatedAt,
          stalenessMs: 120_000,
          stale: true,
        },
      ],
    });

    expect(result).toEqual({
      scope: 'control_plane_global',
      staleAfterMs: 60_000,
      generatedAt: '2026-07-21T20:00:00.000Z',
      items: [
        {
          projectionName: 'run_status',
          updatedAt,
          stalenessMs: 120_000,
          stale: true,
        },
      ],
    });
    expect(result.items[0]).not.toHaveProperty('id');
    expect(result.items[0]).not.toHaveProperty('streamKey');
    expect(result.items[0]).not.toHaveProperty('lastEventId');
    expect(result.items[0]).not.toHaveProperty('lastSequenceNumber');
  });
});
