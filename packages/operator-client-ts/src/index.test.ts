import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OperatorApiError,
  createOperatorClient,
  mergeFiniteRunEvents,
  shouldRetryOperatorRequest,
} from './index.js';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

beforeEach(() => vi.restoreAllMocks());

describe('operator client', () => {
  it('injects attribution and preserves opaque run-event cursors', async () => {
    const fetch = vi.fn(async () =>
      json({
        items: [{ id: 'event-1', event_type: 'completed' }],
        nextCursor: null,
        resumeCursor: 'opaque-next==',
        complete: true,
      }),
    );
    const client = createOperatorClient({
      fetch,
      headers: {
        authorization: 'Bearer short-lived-session',
        'x-factory-floor-principal-id': 'operator:user-1',
        'x-factory-floor-adapter': 'minimal-shell',
      },
    });

    await expect(
      client.runEvents('run-1', { cursor: 'opaque-start==', limit: 25 }),
    ).resolves.toEqual({
      items: [{ id: 'event-1', eventType: 'completed' }],
      nextCursor: null,
      resumeCursor: 'opaque-next==',
      complete: true,
    });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/v1/operator/runs/run-1/events');
    expect(url).toContain('cursor=opaque-start%3D%3D');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer short-lived-session',
      'x-factory-floor-principal-id': 'operator:user-1',
      'x-factory-floor-adapter': 'minimal-shell',
      accept: 'application/json',
    });
  });

  it('retries only safe transient failures', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: 'busy' } }, { status: 503 }))
      .mockResolvedValueOnce(
        json({ status: 'healthy', service: 'control-plane' }),
      );
    const client = createOperatorClient({
      fetch,
      retryAttempts: 2,
      sleep: async () => undefined,
    });

    await expect(client.health()).resolves.toEqual({
      status: 'healthy',
      service: 'control-plane',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      shouldRetryOperatorRequest(
        new OperatorApiError('http', 'invalid cursor', 400, 'invalid_cursor'),
        1,
        2,
      ),
    ).toBe(false);
  });

  it('maps canonical not-found and malformed-response failures', async () => {
    const missing = createOperatorClient({
      fetch: vi.fn(async () =>
        json({ error: { code: 'run_not_found' } }, { status: 404 }),
      ),
    });
    await expect(missing.runStatus('missing')).rejects.toMatchObject({
      kind: 'not-found',
      status: 404,
      code: 'run_not_found',
    });

    const malformed = createOperatorClient({
      fetch: vi.fn(async () => json({ items: [] })),
    });
    await expect(malformed.runAlerts('run-1')).rejects.toMatchObject({
      kind: 'malformed-response',
    });
  });

  it('deduplicates finite event retries and carries the resume cursor', () => {
    expect(
      mergeFiniteRunEvents(
        [{ id: 'event-1' }],
        {
          items: [{ id: 'event-1' }, { id: 'event-2' }],
          nextCursor: null,
          resumeCursor: 'resume-2',
          complete: true,
        },
        10,
      ),
    ).toEqual({
      items: [{ id: 'event-1' }, { id: 'event-2' }],
      resumeCursor: 'resume-2',
      complete: true,
    });
  });
});
