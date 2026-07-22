import { describe, expect, it, vi } from 'vitest';
import { createRunDetailsClient } from './run-details.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('run details client', () => {
  it('uses the run-scoped endpoint and normalizes database field names', async () => {
    const fetch = vi.fn(async () =>
      json({
        run_id: 'run-1',
        limits: { records: 25 },
        approvals: [
          {
            id: 'approval-1',
            action_id: 'action-1',
            requested_at: '2026-07-20T00:00:00.000Z',
          },
        ],
        policy_decisions: [],
        resources: [],
        derivations: [],
        projection_freshness: {
          scope: 'control_plane_global',
          stale_after_ms: 60000,
          generated_at: '2026-07-20T00:00:00.000Z',
          items: [],
        },
      }),
    );
    const client = createRunDetailsClient({
      baseUrl: 'https://factory.example',
      token: 'activity-token',
      principalId: 'discord:user-1',
      adapter: 'discord-agent',
      fetch: fetch as typeof globalThis.fetch,
    });

    const result = await client.getRunDetails('run-1', { limit: 25 });

    expect(result.runId).toBe('run-1');
    expect(result.approvals[0]).toMatchObject({
      actionId: 'action-1',
      requestedAt: '2026-07-20T00:00:00.000Z',
    });
    expect(result.projectionFreshness).toMatchObject({
      scope: 'control_plane_global',
      staleAfterMs: 60000,
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://factory.example/api/v1/operator/runs/run-1/details?limit=25',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        headers: expect.objectContaining({
          authorization: 'Bearer activity-token',
          'x-factory-floor-principal-id': 'discord:user-1',
          'x-factory-floor-adapter': 'discord-agent',
        }),
      }),
    );
  });
});
