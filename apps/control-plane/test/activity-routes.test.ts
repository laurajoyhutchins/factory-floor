import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  ActivitySessionService,
} from '@factory-floor/runtime-core';
import { registerActivityRoutes } from '../src/routes/activity.js';
import {
  registerServiceAuth,
  signRequest,
  signatureHeader,
} from '../src/service-auth.js';

const TEST_KEYS = {
  agentToFactoryKey: 'test-agent-key-abcdef123456',
  factoryToAgentKey: 'test-factory-key-abcdef123456',
};

function testNonceDb() {
  const used = new Set<string>();
  return {
    isNonceUsed: vi.fn(async (keyId: string, nonce: string) =>
      used.has(`${keyId}:${nonce}`),
    ),
    recordNonce: vi.fn(async (keyId: string, nonce: string) => {
      used.add(`${keyId}:${nonce}`);
    }),
  };
}

function validAuthHeader(
  method: string,
  path: string,
  body: unknown,
  now = Date.now(),
): string {
  const { keyId, timestamp, nonce, signature } = signRequest(
    TEST_KEYS,
    method,
    path,
    body,
    now,
  );
  return signatureHeader(keyId, timestamp, nonce, signature);
}

describe('activity session routes', () => {
  async function app() {
    const instance = Fastify();
    const nonceDb = testNonceDb();
    registerServiceAuth(instance, {
      keys: TEST_KEYS,
      db: nonceDb,
      maxSkewMs: 30_000,
    });

    const mockSessionService = {
      createOrJoinSession: vi.fn(),
      refreshSession: vi.fn(),
      revokeSession: vi.fn(),
      closeInstance: vi.fn(),
    } as unknown as ActivitySessionService;

    await registerActivityRoutes(instance, mockSessionService);
    return { instance, mockSessionService, nonceDb };
  }

  it('creates a session with valid service auth', async () => {
    const { instance, mockSessionService } = await app();
    const now = Date.now();

    mockSessionService.createOrJoinSession = vi.fn().mockResolvedValue({
      instanceBindingId: 'binding-1',
      session: {
        sessionId: 'session-token-abc',
        tokenDigest: 'digest-abc',
        expiresAt: new Date(now + 3_600_000),
        idleExpiresAt: new Date(now + 300_000),
      },
    });

    const response = await instance.inject({
      method: 'POST',
      url: '/api/v1/discord/activity/sessions',
      headers: {
        'x-factory-floor-service-auth': validAuthHeader(
          'POST',
          '/api/v1/discord/activity/sessions',
          {
            applicationId: 'app-1',
            instanceId: 'instance-1',
            installationId: 'install-1',
            launchId: 'launch-1',
            principalId: 'discord:user-1',
            adapter: 'discord-agent',
          },
          now,
        ),
      },
      payload: {
        applicationId: 'app-1',
        instanceId: 'instance-1',
        installationId: 'install-1',
        launchId: 'launch-1',
        principalId: 'discord:user-1',
        adapter: 'discord-agent',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      instanceBindingId: 'binding-1',
      sessionToken: 'session-token-abc',
    });
    expect(typeof body.expiresAt).toBe('string');
    expect(typeof body.idleExpiresAt).toBe('string');

    await instance.close();
  });

  it('rejects unauthenticated requests', async () => {
    const { instance } = await app();

    const response = await instance.inject({
      method: 'POST',
      url: '/api/v1/discord/activity/sessions',
      payload: {
        applicationId: 'app-1',
        instanceId: 'instance-1',
        installationId: 'install-1',
        launchId: 'launch-1',
        principalId: 'discord:user-1',
        adapter: 'discord-agent',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'service_auth_header_required' },
    });

    await instance.close();
  });

  it('refreshes a session', async () => {
    const { instance, mockSessionService } = await app();
    const now = Date.now();

    mockSessionService.refreshSession = vi.fn().mockResolvedValue({
      sessionId: 'new-session-token',
      tokenDigest: 'new-digest',
      expiresAt: new Date(now + 3_600_000),
      idleExpiresAt: new Date(now + 300_000),
    });

    const response = await instance.inject({
      method: 'POST',
      url: '/api/v1/discord/activity/sessions/refresh',
      headers: {
        'x-factory-floor-service-auth': validAuthHeader(
          'POST',
          '/api/v1/discord/activity/sessions/refresh',
          { sessionToken: 'existing-token' },
          now,
        ),
      },
      payload: { sessionToken: 'existing-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionToken: 'new-session-token',
    });

    await instance.close();
  });

  it('returns 404 for unknown or expired session on refresh', async () => {
    const { instance, mockSessionService } = await app();
    const now = Date.now();

    mockSessionService.refreshSession = vi.fn().mockResolvedValue(null);

    const response = await instance.inject({
      method: 'POST',
      url: '/api/v1/discord/activity/sessions/refresh',
      headers: {
        'x-factory-floor-service-auth': validAuthHeader(
          'POST',
          '/api/v1/discord/activity/sessions/refresh',
          { sessionToken: 'expired-token' },
          now,
        ),
      },
      payload: { sessionToken: 'expired-token' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'session_not_found' },
    });

    await instance.close();
  });

  it('revokes a session', async () => {
    const { instance, mockSessionService } = await app();
    const now = Date.now();

    mockSessionService.revokeSession = vi.fn().mockResolvedValue(true);

    const response = await instance.inject({
      method: 'POST',
      url: '/api/v1/discord/activity/sessions/revoke',
      headers: {
        'x-factory-floor-service-auth': validAuthHeader(
          'POST',
          '/api/v1/discord/activity/sessions/revoke',
          { sessionToken: 'token-to-revoke' },
          now,
        ),
      },
      payload: { sessionToken: 'token-to-revoke' },
    });

    expect(response.statusCode).toBe(204);

    await instance.close();
  });

  it('requires required body fields for session creation', async () => {
    const { instance } = await app();
    const now = Date.now();

    const response = await instance.inject({
      method: 'POST',
      url: '/api/v1/discord/activity/sessions',
      headers: {
        'content-type': 'application/json',
        'x-factory-floor-service-auth': validAuthHeader(
          'POST',
          '/api/v1/discord/activity/sessions',
          {},
          now,
        ),
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'applicationId_required' },
    });

    await instance.close();
  });
});
