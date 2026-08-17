import { describe, expect, it, vi } from 'vitest';
import { createCancellableRunsClient } from './cancellable-runs.js';

describe('cancellable-run operator client', () => {
  it('uses the authoritative paged cancellable-run endpoint', async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toContain(
          '/api/v1/operator/cancellable-runs?cursor=previous-run&limit=10',
        );
        expect(init?.headers).toMatchObject({
          'x-factory-floor-principal-id': 'standalone-console',
          'x-factory-floor-adapter': 'standalone-console',
        });
        return new Response(
          JSON.stringify({
            items: [
              {
                runId: 'run-cancellable',
                commandType: 'development.task',
                regionId: 'region-1',
                regionName: 'repository-task',
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    );
    const client = createCancellableRunsClient({
      principalId: 'standalone-console',
      adapter: 'standalone-console',
      fetch: fetch as typeof globalThis.fetch,
    });

    const page = await client.list({ cursor: 'previous-run', limit: 10 });
    expect(page.items[0]?.runId).toBe('run-cancellable');
  });
});
