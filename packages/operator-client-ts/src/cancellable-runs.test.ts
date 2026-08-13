import { describe, expect, it, vi } from 'vitest';
import {
  createOperatorClient,
  type InspectionRecord,
  type Page,
  type PageOptions,
} from './index.js';

describe('cancellable-run operator client', () => {
  it('uses the authoritative paged cancellable-run endpoint', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
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
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    const client = createOperatorClient({
      principalId: 'standalone-console',
      adapter: 'standalone-console',
      fetch: fetch as typeof globalThis.fetch,
    });
    const cancellableRuns = (
      client as unknown as {
        cancellableRuns(
          options?: PageOptions,
        ): Promise<Page<InspectionRecord>>;
      }
    ).cancellableRuns;

    expect(cancellableRuns).toBeTypeOf('function');
    const page = await cancellableRuns({
      cursor: 'previous-run',
      limit: 10,
    });
    expect(page.items[0]?.runId).toBe('run-cancellable');
  });
});
