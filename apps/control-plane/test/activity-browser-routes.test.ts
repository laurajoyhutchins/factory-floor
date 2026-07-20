import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ActivitySessionService } from '../src/activity-session-service.js';
import type { ActivitySessionAuthorizer } from '../src/activity-session-read-authorizer.js';
import { registerActivityBrowserRoutes } from '../src/routes/activity-browser.js';

const session = {
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
  expiresAt: new Date('2026-07-20T20:00:00.000Z'),
  idleExpiresAt: new Date('2026-07-20T19:05:00.000Z'),
};

async function app() {
  const instance = Fastify();
  const sessionService = {
    refreshSession: vi.fn(),
    revokeSession: vi.fn(),
  } as unknown as ActivitySessionService;
  const authorizer = {
    resolveSession: vi.fn(),
  } as unknown as ActivitySessionAuthorizer;
  await registerActivityBrowserRoutes(instance, sessionService, authorizer);
  return { instance, sessionService, authorizer };
}

describe('Activity browser session routes', () => {
  it('returns immutable no-store session context', async () => {
    const { instance, authorizer } = await app();
    authorizer.resolveSession = vi.fn().mockResolvedValue(session);
    const response = await instance.inject({
      method: 'GET',
      url: '/api/v1/discord/activity/session',
      headers: { authorization: 'Bearer session-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      instanceBindingId: 'binding-1',
      applicationId: 'app-1',
      instanceId: 'instance-1',
      installationId: 'installation-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      threadId: null,
      principalId: 'discord:user-1',
      adapter: 'discord-agent',
      runId: 'run-1',
      expiresAt: '2026-07-20T20:00:00.000Z',
      idleExpiresAt: '2026-07-20T19:05:00.000Z',
    });
    await instance.close();
  });

  it('rotates browser session tokens without accepting a body-selected token', async () => {
    const { instance, sessionService } = await app();
    sessionService.refreshSession = vi.fn().mockResolvedValue({
      sessionToken: 'rotated-token',
      expiresAt: session.expiresAt,
      idleExpiresAt: new Date('2026-07-20T19:10:00.000Z'),
    });
    const response = await instance.inject({
      method: 'POST',
      url: '/api/v1/discord/activity/session/refresh',
      headers: {
        authorization: 'Bearer current-token',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ sessionToken: 'attacker-selected-token' }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(sessionService.refreshSession).toHaveBeenCalledWith('current-token');
    expect(response.json()).toMatchObject({ sessionToken: 'rotated-token' });
    await instance.close();
  });

  it('fails closed for missing, expired, or revoked sessions', async () => {
    const { instance, authorizer, sessionService } = await app();
    authorizer.resolveSession = vi.fn().mockResolvedValue(null);
    sessionService.refreshSession = vi.fn().mockResolvedValue(null);

    for (const request of [
      { method: 'GET' as const, url: '/api/v1/discord/activity/session' },
      {
        method: 'POST' as const,
        url: '/api/v1/discord/activity/session/refresh',
        headers: { authorization: 'Bearer expired-token' },
      },
    ]) {
      const response = await instance.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    await instance.close();
  });

  it('revokes the bearer session and returns no content', async () => {
    const { instance, sessionService } = await app();
    sessionService.revokeSession = vi.fn().mockResolvedValue(true);
    const response = await instance.inject({
      method: 'POST',
      url: '/api/v1/discord/activity/session/revoke',
      headers: { authorization: 'Bearer current-token' },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(sessionService.revokeSession).toHaveBeenCalledWith('current-token');
    await instance.close();
  });
});
