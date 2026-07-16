import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError, consoleApi, readOnlyInspectionPaths } from './client.js';
const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
beforeEach(() => {
  vi.restoreAllMocks();
});
describe('console read-only api', () => {
  it('retrieves pages and preserves opaque cursors', async () => {
    const fetch = vi.fn(async () =>
      json({ items: [{ id: 'a' }], nextCursor: 'opaque==' }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      consoleApi.events({ cursor: 'opaque==', limit: 1 }),
    ).resolves.toEqual({ items: [{ id: 'a' }], nextCursor: 'opaque==' });
    const firstCall = (
      fetch.mock.calls as unknown as [string, RequestInit][]
    )[0]!;
    expect(firstCall[0]).toContain('cursor=opaque');
    expect(firstCall[1].method).toBe('GET');
  });
  it('classifies invalid cursor/limit http responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ error: { code: 'invalid_cursor' } }, { status: 400 }),
      ),
    );
    await expect(consoleApi.regions({ cursor: 'bad' })).rejects.toMatchObject({
      kind: 'http',
      status: 400,
    });
  });
  it('classifies 404 execution and artifact responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ error: { code: 'execution_not_found' } }, { status: 404 }),
      ),
    );
    await expect(consoleApi.execution('missing')).rejects.toMatchObject({
      kind: 'not-found',
    });
    await expect(consoleApi.artifactLineage('missing')).rejects.toMatchObject({
      kind: 'not-found',
    });
  });
  it('classifies aborted requests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('stop', 'AbortError');
      }),
    );
    await expect(consoleApi.health()).rejects.toMatchObject({
      kind: 'aborted',
    });
  });
  it('classifies malformed json and non-json errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{bad', { status: 200 })),
    );
    await expect(consoleApi.health()).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await expect(consoleApi.health()).rejects.toMatchObject({ kind: 'http' });
  });
  it('handles empty pages normally and exposes no mutation paths', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ items: [], nextCursor: null })),
    );
    await expect(consoleApi.artifacts()).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(JSON.stringify(readOnlyInspectionPaths)).not.toContain('rebuild');
    expect(
      Object.values(readOnlyInspectionPaths).every(
        (p) => !p.includes('/worker/') && !p.includes('/registrations'),
      ),
    ).toBe(true);
  });
});
