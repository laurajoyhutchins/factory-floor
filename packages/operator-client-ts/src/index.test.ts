import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OperatorClientError,
  configureDefaultOperatorClient,
  createOperatorClient,
  operatorClient,
  readOnlyInspectionPaths,
} from './index.js';

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('operator client', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('injects bearer authentication and durable attribution', async () => {
    const fetch = vi.fn(async () => json({ status: 'healthy' }));
    const client = createOperatorClient({
      baseUrl: 'https://factory.example',
      token: 'operator-secret',
      principalId: 'host:user-1',
      adapter: 'embedded-host',
      fetch,
    });

    await client.operatorStatus();

    expect(client.streamPath).toBe(
      'https://factory.example/api/v1/inspect/stream',
    );
    expect(fetch).toHaveBeenCalledWith(
      'https://factory.example/api/v1/operator/status',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer operator-secret',
          'x-factory-floor-principal-id': 'host:user-1',
          'x-factory-floor-adapter': 'embedded-host',
        }),
      }),
    );
  });

  it('retries only safe transient reads', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: 'busy' } }, { status: 503 }))
      .mockResolvedValueOnce(json({ status: 'healthy' }));
    const client = createOperatorClient({
      principalId: 'test',
      adapter: 'test',
      fetch,
      retry: { maxAttempts: 2, sleep: async () => undefined },
    });

    await expect(client.operatorStatus()).resolves.toMatchObject({
      status: 'healthy',
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    fetch.mockReset();
    fetch.mockResolvedValue(json({ error: { code: 'busy' } }, { status: 503 }));
    await expect(
      client.submitTask({
        clientRequestId: 'request-1',
        repository: 'owner/repo',
        objective: 'Do the work.',
        acceptanceCriteria: ['It passes.'],
      }),
    ).rejects.toBeInstanceOf(OperatorClientError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves opaque cursors and validates finite event pages', async () => {
    const fetch = vi.fn(async () =>
      json({
        items: [{ id: 'event-1', eventType: 'run.started' }],
        nextCursor: null,
        resumeCursor: 'opaque==',
        complete: true,
      }),
    );
    const client = createOperatorClient({
      principalId: 'test',
      adapter: 'test',
      fetch,
    });

    await expect(
      client.runEvents('run-1', { cursor: 'opaque==', limit: 1 }),
    ).resolves.toMatchObject({ resumeCursor: 'opaque==', complete: true });
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(String(calls[0]?.[0])).toContain('cursor=opaque%3D%3D');
  });

  it('maps canonical HTTP errors and rejects malformed responses', async () => {
    const fetch = vi.fn(async () =>
      json(
        { error: { code: 'cursor_expired', message: 'cursor_expired' } },
        { status: 400 },
      ),
    );
    const client = createOperatorClient({
      principalId: 'test',
      adapter: 'test',
      fetch,
      retry: { maxAttempts: 1 },
    });

    await expect(client.runEvents('run-1')).rejects.toMatchObject({
      kind: 'http',
      status: 400,
      code: 'cursor_expired',
    });

    fetch.mockResolvedValueOnce(
      json({ items: 'not-an-array', nextCursor: null }),
    );
    await expect(client.regions()).rejects.toMatchObject({
      kind: 'malformed-response',
    });
  });

  it('keeps the compatibility path export read-only', () => {
    const paths = Object.values(readOnlyInspectionPaths);
    expect(paths).toContain('/health');
    expect(
      paths.every(
        (path) => path === '/health' || path.startsWith('/api/v1/inspect/'),
      ),
    ).toBe(true);
    expect(JSON.stringify(readOnlyInspectionPaths)).not.toContain(
      '/api/v1/operator',
    );
  });

  it('supports a stable injected default facade', async () => {
    const fetch = vi.fn(async () => json({ status: 'healthy', service: 'cp' }));
    configureDefaultOperatorClient(
      createOperatorClient({ principalId: 'shell', adapter: 'shell', fetch }),
    );

    await expect(operatorClient.health()).resolves.toEqual({
      status: 'healthy',
      service: 'cp',
    });
  });
});
