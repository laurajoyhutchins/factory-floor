import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

const regionId = '019bb22e-58b0-7d87-8000-000000000511';
const instantiationId = '019bb22e-58b0-7d87-8000-000000000512';

describe('ff inspect instantiations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('builds a bounded region-scoped list request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await main([
      'inspect',
      'instantiations',
      '--region-id',
      regionId,
      '--limit',
      '2',
      '--json',
    ]);

    expect(result).toBe(0);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v1/inspect/instantiations');
    expect(url.searchParams.get('regionId')).toBe(regionId);
    expect(url.searchParams.get('limit')).toBe('2');
  });

  it('requests one instantiation detail by identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: instantiationId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await main([
      'inspect',
      'instantiations',
      instantiationId,
      '--json',
    ]);

    expect(result).toBe(0);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe(
      `/api/v1/inspect/instantiations/${instantiationId}`,
    );
  });
});
