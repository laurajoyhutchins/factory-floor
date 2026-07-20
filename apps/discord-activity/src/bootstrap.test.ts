import { describe, expect, it, vi } from 'vitest';
import { beginActivityBootstrap } from './bootstrap.js';

describe('Discord Activity bootstrap', () => {
  it('binds SDK authorization to broker state and returns only trusted run context', async () => {
    const calls: string[] = [];
    const host = {
      instanceId: 'instance-1',
      ready: vi.fn(async () => void calls.push('ready')),
      authorize: vi.fn(async (request: Record<string, unknown>) => {
        calls.push('authorize');
        expect(request).toMatchObject({
          client_id: 'application-1',
          state: 'state-1',
          code_challenge: 'challenge-1',
          code_challenge_method: 'S256',
        });
        return { code: 'authorization-code' };
      }),
      authenticate: vi.fn(async (accessToken: string) => {
        calls.push('authenticate');
        expect(accessToken).toBe('discord-access-token');
      }),
    };
    const broker = {
      startOAuth: vi.fn(async (request: Record<string, unknown>) => {
        calls.push('start');
        expect(request).toEqual({
          instanceId: 'instance-1',
          codeChallenge: 'challenge-1',
        });
        return {
          state: 'state-1',
          clientId: 'application-1',
          scopes: ['identify'],
          codeChallengeMethod: 'S256' as const,
          expiresAt: Date.now() + 60_000,
        };
      }),
      bootstrap: vi.fn(async (request: Record<string, unknown>) => {
        calls.push('bootstrap');
        expect(request).toEqual({
          state: 'state-1',
          instanceId: 'instance-1',
          code: 'authorization-code',
          codeVerifier: 'verifier-1',
          redirectUri: 'https://123.discordsays.com/.proxy/oauth/callback',
        });
        return {
          discord: {
            accessToken: 'discord-access-token',
            tokenType: 'Bearer',
            expiresIn: 3600,
            scope: 'identify',
          },
          factoryFloor: {
            instanceBindingId: 'binding-1',
            sessionToken: 'session-token',
            expiresAt: '2026-07-20T20:00:00.000Z',
            idleExpiresAt: '2026-07-20T19:05:00.000Z',
          },
          context: { kind: 'run' as const, projectId: 'project-1', runId: 'run-1' },
        };
      }),
    };

    const result = await beginActivityBootstrap({
      host,
      broker,
      redirectUri: 'https://123.discordsays.com/.proxy/oauth/callback',
      createPkce: async () => ({
        verifier: 'verifier-1',
        challenge: 'challenge-1',
      }),
    });

    expect(calls).toEqual([
      'ready',
      'start',
      'authorize',
      'bootstrap',
      'authenticate',
    ]);
    expect(result).toMatchObject({
      runId: 'run-1',
      projectId: 'project-1',
      instanceBindingId: 'binding-1',
      sessionToken: 'session-token',
    });
  });

  it('rejects bootstrap responses without a run binding', async () => {
    await expect(
      beginActivityBootstrap({
        host: {
          instanceId: 'instance-1',
          ready: async () => undefined,
          authorize: async () => ({ code: 'code' }),
          authenticate: async () => undefined,
        },
        broker: {
          startOAuth: async () => ({
            state: 'state',
            clientId: 'application-1',
            scopes: ['identify'],
            codeChallengeMethod: 'S256',
            expiresAt: Date.now() + 60_000,
          }),
          bootstrap: async () => ({
            discord: {
              accessToken: 'token',
              tokenType: 'Bearer',
              expiresIn: 3600,
              scope: 'identify',
            },
            factoryFloor: {
              instanceBindingId: 'binding',
              sessionToken: 'session',
              expiresAt: '2026-07-20T20:00:00.000Z',
              idleExpiresAt: '2026-07-20T19:05:00.000Z',
            },
            context: { kind: 'project', projectId: 'project-1' },
          }),
        },
        redirectUri: 'https://123.discordsays.com/.proxy/oauth/callback',
        createPkce: async () => ({ verifier: 'verifier', challenge: 'challenge' }),
      }),
    ).rejects.toThrow('activity_run_binding_required');
  });
});
