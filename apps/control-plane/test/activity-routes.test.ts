import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  ActivitySessionError,
  ActivitySessionService,
} from '../src/activity-session-service.js';
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
    consumeNonce: vi.fn(async (keyId: string, nonce: string) => {
      const value = `${keyId}:${nonce}`;
      if (used.has(value)) return false;
      used.add(value);
      return true;
    }),
  };
}

function signedJson(
  path: string,
  body: Record<string, unknown>,
  now = Date.now(),
) {
  const payload = JSON.stringify(body);
  const signed = signRequest(
    TEST_KEYS,
    'agent-to-ff',
    'POST',
    path,
    payload,
    now,
  );
  return {
    payload,
    headers: {
      'content-type': 'application/json',
      'x-factory-floor-service-auth': signatureHeader(
        signed.keyId,
        signed.timestamp,
        signed.nonce,
        signed.signature,
      ),
    },
  };
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

  it('creates a no-store session with valid service auth', async () => {
    const { instance, mockSessionService } = await app();
    const now = Date.now();
    const path = '/api/v1/discord/activity/sessions';
    const requestBody = {
      applicationId: 'app-1',
      instanceId: 'instance-1',
      installationId: 'install-1',
      launchId: 'launch-1',
      principalId: 'discord:user-1',
      adapter: 'discord-agent',
    };

    mockSessionService.createOrJoinSession = vi.fn().mockResolvedValue({
      instanceBindingId: 'binding-1',
      session: {
        sessionToken: 'session-token-abc',
        expiresAt: new Date(now + 3_600_000),
        idleExpiresAt: new Date(now + 300_000),
      },
    });

    const response = await instance.inject({
      method: 'POST',
      url: path,
      ...signedJson(path, requestBody, now),
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      instanceBindingId: 'binding-1',
      sessionToken: 'session-token-abc',
    });
    expect(mockSessionService.createOrJoinSession).toHaveBeenCalledWith(
      requestBody,
    );

    await instance.close();
  });

  it('rejects unauthenticated requests', async () => {
    const { instance } = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/v1/discord/activity/sessions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        applicationId: 'app-1',
        instanceId: 'instance-1',
        installationId: 'install-1',
        launchId: 'launch-1',
        principalId: 'discord:user-1',
        adapter: 'discord-agent',
      }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'service_auth_header_required' },
    });
    await instance.close();
  });

  it('refreshes and rotates a session token', async () => {
    const { instance, mockSessionService } = await app();
    const now = Date.now();
    const path = '/api/v1/discord/activity/sessions/refresh';

    mockSessionService.refreshSession = vi.fn().mockResolvedValue({
      sessionToken: 'new-session-token',
      expiresAt: new Date(now + 3_600_000),
      idleExpiresAt: new Date(now + 300_000),
    });

    const response = await instance.inject({
      method: 'POST',
      url: path,
      ...signedJson(path, { sessionToken: 'existing-token' }, now),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      sessionToken: 'new-session-token',
    });
    await instance.close();
  });

  it('returns 404 for an unknown, expired, or concurrently rotated session', async () => {
    const { instance, mockSessionService } = await app();
    const path = '/api/v1/discord/activity/sessions/refresh';
    mockSessionService.refreshSession = vi.fn().mockResolvedValue(null);

    const response = await instance.inject({
      method: 'POST',
      url: path,
      ...signedJson(path, { sessionToken: 'expired-token' }),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'session_not_found' },
    });
    await instance.close();
  });

  it('revokes a session', async () => {
    const { instance, mockSessionService } = await app();
    const path = '/api/v1/discord/activity/sessions/revoke';
    mockSessionService.revokeSession = vi.fn().mockResolvedValue(true);

    const response = await instance.inject({
      method: 'POST',
      url: path,
      ...signedJson(path, { sessionToken: 'token-to-revoke' }),
    });

    expect(response.statusCode).toBe(204);
    await instance.close();
  });

  it('requires all trusted assertion fields', async () => {
    const { instance } = await app();
    const path = '/api/v1/discord/activity/sessions';
    const response = await instance.inject({
      method: 'POST',
      url: path,
      ...signedJson(path, {}),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'applicationId_required' },
    });
    await instance.close();
  });

  it('reports immutable binding conflicts without exposing internals', async () => {
    const { instance, mockSessionService } = await app();
    const path = '/api/v1/discord/activity/sessions';
    mockSessionService.createOrJoinSession = vi
      .fn()
      .mockRejectedValue(new ActivitySessionError('instance_binding_mismatch'));

    const response = await instance.inject({
      method: 'POST',
      url: path,
      ...signedJson(path, {
        applicationId: 'app-1',
        instanceId: 'instance-1',
        installationId: 'wrong-installation',
        launchId: 'launch-2',
        principalId: 'discord:user-2',
        adapter: 'discord-agent',
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'instance_binding_mismatch',
        message: 'instance_binding_mismatch',
      },
    });
    await instance.close();
  });
});
