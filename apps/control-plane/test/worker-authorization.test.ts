import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerWorkerRoutes } from '../src/routes/worker.js';

describe('worker authorization', () => {
  it('binds a worker token to one identity and a server-side selector allowlist', async () => {
    const claim = vi.fn(async () => ({
      protocolVersion: '1.0' as const,
      claimed: false as const,
      retryAfterMs: 250,
    }));
    const app = Fastify();
    await registerWorkerRoutes(
      app,
      { claim } as never,
      {
        workers: {
          'worker-a': {
            token: 'worker-a-secret',
            capabilities: ['retrieve@1'],
          },
        },
      },
    );

    const wrongIdentity = await app.inject({
      method: 'POST',
      url: '/worker/v1/claim',
      headers: { authorization: 'Bearer worker-a-secret' },
      payload: {
        protocolVersion: '1.0',
        workerId: 'worker-b',
        capabilities: ['retrieve@1'],
      },
    });
    expect(wrongIdentity.statusCode).toBe(403);

    const undelegated = await app.inject({
      method: 'POST',
      url: '/worker/v1/claim',
      headers: { authorization: 'Bearer worker-a-secret' },
      payload: {
        protocolVersion: '1.0',
        workerId: 'worker-a',
        capabilities: ['verify@1'],
      },
    });
    expect(undelegated.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'POST',
      url: '/worker/v1/claim',
      headers: { authorization: 'Bearer worker-a-secret' },
      payload: {
        protocolVersion: '1.0',
        workerId: 'worker-a',
        capabilities: ['retrieve@1'],
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(claim).toHaveBeenCalledWith({
      protocolVersion: '1.0',
      workerId: 'worker-a',
      capabilities: ['retrieve@1'],
    });

    await app.close();
  });
});
