import { describe, expect, it, vi } from 'vitest';
import { createStandaloneConsoleClient } from './client.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('standalone console client bootstrap', () => {
  it('injects shell-owned credentials and attribution without exposing them to UI modules', async () => {
    const fetch = vi.fn(async () => json({ status: 'healthy' }));
    const client = createStandaloneConsoleClient(
      { token: 'operator-secret' },
      fetch,
    );

    await client.operatorStatus();

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/operator/status',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer operator-secret',
          'x-factory-floor-principal-id': 'standalone-console',
          'x-factory-floor-adapter': 'standalone-console',
        }),
      }),
    );
  });
});
