import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  ProductionReadinessService,
  registerProductionHealthRoutes,
} from '../src/production-health.js';
import { registerControlPlaneSecurity } from '../src/security.js';

async function healthApp(checks: {
  database: () => Promise<unknown>;
  artifactStore: () => Promise<unknown>;
}) {
  const app = Fastify({ logger: false });
  registerControlPlaneSecurity(app, {
    operatorToken: 'operator-secret',
    adminToken: 'admin-secret',
  });
  registerProductionHealthRoutes(app, new ProductionReadinessService(checks));
  await app.ready();
  return app;
}

describe('production health routes', () => {
  it('reports liveness without requiring authentication or dependency access', async () => {
    const database = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    const artifactStore = vi.fn(async () => {
      throw new Error('artifact store unavailable');
    });
    const app = await healthApp({ database, artifactStore });

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'control-plane',
    });
    expect(database).not.toHaveBeenCalled();
    expect(artifactStore).not.toHaveBeenCalled();
    await app.close();
  });

  it('reports ready only when every dependency check passes', async () => {
    const app = await healthApp({
      database: async () => undefined,
      artifactStore: async () => undefined,
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      service: 'control-plane',
      checks: { database: 'ready', artifactStore: 'ready' },
    });
    await app.close();
  });

  it('returns stable non-secret failure details when a dependency is unavailable', async () => {
    const app = await healthApp({
      database: async () => {
        throw new Error('postgres://user:secret@internal/database');
      },
      artifactStore: async () => undefined,
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      service: 'control-plane',
      checks: { database: 'not_ready', artifactStore: 'ready' },
    });
    expect(response.body).not.toContain('secret');
    expect(response.headers['www-authenticate']).toBeUndefined();
    await app.close();
  });
});
