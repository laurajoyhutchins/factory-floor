import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PortfolioClientError,
  createPortfolioClient,
  portfolioReadPaths,
} from './portfolio.js';

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('portfolio read client', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('uses only bounded read routes with injected authentication', async () => {
    const fetch = vi.fn(async () =>
      json({ schema: 'portfolio-reconciler-status-v1', mode: 'shadow' }),
    );
    const client = createPortfolioClient({
      baseUrl: 'https://portfolio.example',
      token: 'portfolio-secret',
      fetch,
      retry: { maxAttempts: 1 },
    });

    await client.status();

    expect(fetch).toHaveBeenCalledWith(
      'https://portfolio.example/api/status',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        headers: expect.objectContaining({
          authorization: 'Bearer portfolio-secret',
          accept: 'application/json',
        }),
      }),
    );
    expect(Object.values(portfolioReadPaths)).toEqual([
      '/api/status',
      '/api/entities',
      '/api/entity',
      '/api/next-work',
      '/api/owner-decisions',
      '/api/search',
    ]);
  });

  it('preserves opaque projections and encodes bounded filters', async () => {
    const projection = {
      entity_key: 'work:release.ci.failure-evidence',
      projection_sha256: 'abc',
      portfolio: { semantic_key: 'release.ci.failure-evidence' },
      payload: { snake_case_is_opaque: true },
    };
    const fetch = vi.fn(async () => json({ items: [projection] }));
    const client = createPortfolioClient({
      baseUrl: 'https://portfolio.example/',
      fetch,
    });

    await expect(
      client.search({ query: 'failure evidence', route: 'hecate', limit: 25 }),
    ).resolves.toEqual({ items: [projection] });
    const [url] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toContain('q=failure+evidence');
    expect(String(url)).toContain('route=hecate');
    expect(String(url)).toContain('limit=25');
  });

  it('retries transient reads and rejects malformed JSON', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ error: 'busy' }, { status: 503 }))
      .mockResolvedValueOnce(json({ schema: 'portfolio-next-work-v1', work: null }));
    const client = createPortfolioClient({
      fetch,
      retry: { maxAttempts: 2, sleep: async () => undefined },
    });

    await expect(client.nextWork()).resolves.toMatchObject({
      schema: 'portfolio-next-work-v1',
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    fetch.mockReset();
    fetch.mockResolvedValueOnce(
      new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(client.status()).rejects.toBeInstanceOf(PortfolioClientError);
  });
});
