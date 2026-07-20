import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  controlPlaneSecurityFromEnv,
  registerControlPlaneSecurity,
} from '../src/security.js';

describe('control-plane HTTP security', () => {
  it('keeps health public and separates operator scope from admin writes', async () => {
    const app = Fastify();
    registerControlPlaneSecurity(app, {
      operatorToken: 'operator-secret',
      adminToken: 'admin-secret',
    });
    app.get('/health', async () => ({ status: 'ok' }));
    app.get('/api/v1/inspect/events', async () => ({ items: [] }));
    app.post('/api/v1/operator/tasks', async () => ({ accepted: true }));
    app.post('/api/v1/commands', async () => ({ accepted: true }));

    await expect(
      app.inject({ method: 'GET', url: '/health' }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: 'GET', url: '/api/v1/inspect/events' }),
    ).resolves.toMatchObject({ statusCode: 401 });
    await expect(
      app.inject({
        method: 'GET',
        url: '/api/v1/inspect/events',
        headers: { authorization: 'Bearer operator-secret' },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: 'POST',
        url: '/api/v1/operator/tasks',
        headers: { authorization: 'Bearer operator-secret' },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: 'POST',
        url: '/api/v1/commands',
        headers: { authorization: 'Bearer operator-secret' },
      }),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      app.inject({
        method: 'POST',
        url: '/api/v1/commands',
        headers: { authorization: 'Bearer admin-secret' },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });

    await app.close();
  });

  it('accepts Activity sessions only for immutable bound-run reads and overrides browser assertions', async () => {
    const app = Fastify();
    const resolveSession = vi.fn(async () => ({
      sessionId: 'session-1',
      instanceBindingId: 'binding-1',
      applicationId: 'app-1',
      instanceId: 'instance-1',
      installationId: 'installation-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      threadId: null,
      principalId: 'discord:user-1',
      adapter: 'discord-agent',
      boundRunId: 'run-1',
      expiresAt: new Date(Date.now() + 60_000),
      idleExpiresAt: new Date(Date.now() + 30_000),
    }));
    registerControlPlaneSecurity(
      app,
      { operatorToken: 'operator-secret', adminToken: 'admin-secret' },
      { resolveSession },
    );
    app.get('/api/v1/operator/runs/:runId', async (request) => ({
      principal: request.headers['x-factory-floor-principal-id'],
      adapter: request.headers['x-factory-floor-adapter'],
    }));
    app.post('/api/v1/operator/runs/:runId/cancel', async () => ({ ok: true }));
    app.get('/api/v1/inspect/events', async () => ({ items: [] }));

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/operator/runs/run-1',
      headers: {
        authorization: 'Bearer activity-session-token',
        'x-factory-floor-principal-id': 'attacker',
        'x-factory-floor-adapter': 'attacker',
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['cache-control']).toBe('no-store');
    expect(allowed.json()).toEqual({
      principal: 'discord:user-1',
      adapter: 'discord-agent',
    });

    await expect(
      app.inject({
        method: 'GET',
        url: '/api/v1/operator/runs/run-2',
        headers: { authorization: 'Bearer activity-session-token' },
      }),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      app.inject({
        method: 'POST',
        url: '/api/v1/operator/runs/run-1/cancel',
        headers: { authorization: 'Bearer activity-session-token' },
      }),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      app.inject({
        method: 'GET',
        url: '/api/v1/inspect/events',
        headers: { authorization: 'Bearer activity-session-token' },
      }),
    ).resolves.toMatchObject({ statusCode: 403 });
    expect(resolveSession).toHaveBeenCalled();
    await app.close();
  });

  it('does not intercept separately authenticated worker or Activity lifecycle namespaces', async () => {
    const app = Fastify();
    registerControlPlaneSecurity(app, {
      operatorToken: 'operator-secret',
      adminToken: 'admin-secret',
    });
    app.post('/worker/v1/claim', async () => ({ claimed: false }));
    app.get('/api/v1/discord/activity/session', async () => ({ session: true }));

    await expect(
      app.inject({ method: 'POST', url: '/worker/v1/claim' }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: 'GET', url: '/api/v1/discord/activity/session' }),
    ).resolves.toMatchObject({ statusCode: 200 });

    await app.close();
  });

  it('fails closed when the real server tokens are absent or equal', () => {
    expect(() => controlPlaneSecurityFromEnv({})).toThrow(
      'CONTROL_PLANE_OPERATOR_TOKEN',
    );
    expect(() =>
      controlPlaneSecurityFromEnv({
        CONTROL_PLANE_OPERATOR_TOKEN: 'same',
        CONTROL_PLANE_ADMIN_TOKEN: 'same',
      }),
    ).toThrow('must be different');
    expect(
      controlPlaneSecurityFromEnv({
        CONTROL_PLANE_OPERATOR_TOKEN: 'operator-secret',
        CONTROL_PLANE_ADMIN_TOKEN: 'admin-secret',
      }),
    ).toEqual({
      operatorToken: 'operator-secret',
      adminToken: 'admin-secret',
    });
  });
});
