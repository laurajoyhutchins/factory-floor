import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  registerWorkerRoutes,
  workerAuthorizationFromEnv,
} from '../src/routes/worker.js';

describe('worker authorization', () => {
  it('binds the fallback token to the configured worker identity', () => {
    expect(
      workerAuthorizationFromEnv({
        FACTORY_FLOOR_WORKER_ID: 'worker-a',
        WORKER_API_BEARER_TOKEN: 'worker-a-secret',
        FACTORY_FLOOR_WORKER_COMPONENT_SELECTORS:
          ' retrieve@1, verify@1,retrieve@1 ',
      }),
    ).toEqual({
      workers: {
        'worker-a': {
          token: 'worker-a-secret',
          componentSelectors: ['retrieve@1', 'verify@1'],
        },
      },
    });
  });

  it('binds a worker token to one identity and a server-side selector allowlist', async () => {
    const claim = vi.fn(async () => ({
      protocolVersion: '1.0' as const,
      claimed: false as const,
      retryAfterMs: 250,
    }));
    const app = Fastify();
    await registerWorkerRoutes(app, { claim } as never, {
      workers: {
        'worker-a': {
          token: 'worker-a-secret',
          componentSelectors: ['retrieve@1'],
        },
      },
    });

    const wrongIdentity = await app.inject({
      method: 'POST',
      url: '/worker/v1/claim',
      headers: { authorization: 'Bearer worker-a-secret' },
      payload: {
        protocolVersion: '1.0',
        workerId: 'worker-b',
        componentSelectors: ['retrieve@1'],
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
        componentSelectors: ['verify@1'],
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
        componentSelectors: ['retrieve@1'],
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(claim).toHaveBeenCalledWith({
      workerId: 'worker-a',
      componentSelectors: ['retrieve@1'],
    });

    await app.close();
  });

  it('accepts deprecated selector environment and canonical authorization JSON', () => {
    expect(
      workerAuthorizationFromEnv({
        FACTORY_FLOOR_WORKER_ID: 'worker-a',
        WORKER_API_BEARER_TOKEN: 'worker-a-secret',
        FACTORY_FLOOR_WORKER_CAPABILITIES: 'retrieve@1, retrieve@1, verify@1',
      }),
    ).toEqual({
      workers: {
        'worker-a': {
          token: 'worker-a-secret',
          componentSelectors: ['retrieve@1', 'verify@1'],
        },
      },
    });

    expect(
      workerAuthorizationFromEnv({
        WORKER_AUTHORIZATION_JSON: JSON.stringify({
          'worker-a': {
            token: 'worker-a-secret',
            componentSelectors: [' retrieve@1 ', 'retrieve@1', 'verify@1'],
          },
        }),
      }),
    ).toEqual({
      workers: {
        'worker-a': {
          token: 'worker-a-secret',
          componentSelectors: ['retrieve@1', 'verify@1'],
        },
      },
    });
  });

  it('accepts legacy authorization JSON but rejects conflicting selector keys', () => {
    expect(
      workerAuthorizationFromEnv({
        WORKER_AUTHORIZATION_JSON: JSON.stringify({
          'worker-a': {
            token: 'worker-a-secret',
            capabilities: ['retrieve@1'],
          },
        }),
      }).workers['worker-a']?.componentSelectors,
    ).toEqual(['retrieve@1']);

    expect(() =>
      workerAuthorizationFromEnv({
        WORKER_AUTHORIZATION_JSON: JSON.stringify({
          'worker-a': {
            token: 'worker-a-secret',
            componentSelectors: ['retrieve@1'],
            capabilities: ['verify@1'],
          },
        }),
      }),
    ).toThrow(/conflicting componentSelectors and capabilities/);
  });
});
