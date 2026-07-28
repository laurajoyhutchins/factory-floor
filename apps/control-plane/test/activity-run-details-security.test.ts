import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerControlPlaneSecurity } from '../src/security.js';

describe('Activity run-details authorization', () => {
  it('permits only the server-bound run and overrides client identity headers', async () => {
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
    app.get('/api/v1/operator/runs/:runId/details', async (request) => ({
      runId: (request.params as { runId: string }).runId,
      principal: request.headers['x-factory-floor-principal-id'],
      adapter: request.headers['x-factory-floor-adapter'],
    }));

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/operator/runs/run-1/details',
      headers: {
        authorization: 'Bearer activity-session-token',
        'x-factory-floor-principal-id': 'attacker',
        'x-factory-floor-adapter': 'attacker',
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['cache-control']).toBe('no-store');
    expect(allowed.json()).toEqual({
      runId: 'run-1',
      principal: 'discord:user-1',
      adapter: 'discord-agent',
    });

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/operator/runs/run-2/details',
      headers: { authorization: 'Bearer activity-session-token' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: { code: 'activity_run_binding_mismatch' },
    });

    await app.close();
  });
});
