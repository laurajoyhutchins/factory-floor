import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

describe('ff authentication', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the operator token for inspection requests', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await main([
        'inspect',
        'events',
        '--server',
        'http://control-plane',
        '--operator-token',
        'operator-secret',
        '--json',
      ]),
    ).toBe(0);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: 'Bearer operator-secret' },
    });
  });

  it('uses the admin token for mutation requests', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ff-auth-'));
    const file = join(directory, 'command.json');
    writeFileSync(
      file,
      JSON.stringify({
        apiVersion: 'factory-floor.dev/v1alpha1',
        kind: 'Command',
        metadata: { name: 'start' },
        spec: {},
      }),
    );
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ disposition: 'accepted', commandId: 'command-1' }),
        {
          status: 202,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await main([
        'command',
        'submit',
        file,
        '--server',
        'http://control-plane',
        '--admin-token',
        'admin-secret',
        '--json',
      ]),
    ).toBe(0);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer admin-secret',
      },
    });
  });
});
