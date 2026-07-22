import { describe, expect, it } from 'vitest';
import { projectRunSafeFreshness } from './template-instantiation-operator-query-service.js';

describe('run-safe projection freshness', () => {
  it('preserves aggregate freshness without exposing global checkpoint identity or progress', () => {
    const result = projectRunSafeFreshness('run-1', {
      staleAfterMs: 60_000,
      generatedAt: '2026-07-21T20:00:00.000Z',
      items: [
        {
          id: 'global-checkpoint-id',
          projectionName: 'run_status',
          streamKey: 'global',
          lastEventId: 'global-event-id',
          lastSequenceNumber: '42',
          updatedAt: '2026-07-21T19:58:00.000Z',
          stalenessMs: 120_000,
          stale: true,
        },
      ],
    });

    expect(result.items).toEqual([
      {
        id: 'run-1:run_status',
        projectionName: 'run_status',
        streamKey: 'run-1',
        lastEventId: null,
        lastSequenceNumber: '0',
        updatedAt: '2026-07-21T19:58:00.000Z',
        stalenessMs: 120_000,
        stale: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('global-checkpoint-id');
    expect(JSON.stringify(result)).not.toContain('global-event-id');
    expect(JSON.stringify(result)).not.toContain('"streamKey":"global"');
  });
});
