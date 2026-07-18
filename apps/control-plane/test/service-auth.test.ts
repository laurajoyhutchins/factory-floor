import { describe, expect, it, vi } from 'vitest';
import {
  ServiceAuthError,
  serviceAuthFromEnv,
  signRequest,
  signatureHeader,
  parseSignatureHeader,
  verifyServiceRequest,
} from '../src/service-auth.js';

function testKeys() {
  return {
    agentToFactoryKey: 'agent-secret-key-abcdef123456',
    factoryToAgentKey: 'factory-secret-key-abcdef123456',
  };
}

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

function testConfig() {
  const nonceDb = testNonceDb();
  return {
    keys: testKeys(),
    db: nonceDb,
    maxSkewMs: 30_000,
    nonceDb,
  };
}

describe('service auth from env', () => {
  it('returns keys when env vars are set', () => {
    const keys = serviceAuthFromEnv({
      FACTORY_FLOOR_AGENT_TO_FACTORY_KEY: 'agent-key',
      FACTORY_FLOOR_FACTORY_TO_AGENT_KEY: 'factory-key',
    });
    expect(keys).toBeDefined();
    expect(keys!.agentToFactoryKey).toBe('agent-key');
    expect(keys!.factoryToAgentKey).toBe('factory-key');
  });

  it('includes previous keys when set', () => {
    const keys = serviceAuthFromEnv({
      FACTORY_FLOOR_AGENT_TO_FACTORY_KEY: 'agent-key',
      FACTORY_FLOOR_FACTORY_TO_AGENT_KEY: 'factory-key',
      FACTORY_FLOOR_PREVIOUS_AGENT_TO_FACTORY_KEY: 'prev-agent-key',
      FACTORY_FLOOR_PREVIOUS_FACTORY_TO_AGENT_KEY: 'prev-factory-key',
    });
    expect(keys!.previousAgentToFactoryKey).toBe('prev-agent-key');
    expect(keys!.previousFactoryToAgentKey).toBe('prev-factory-key');
  });

  it('returns undefined when required keys are missing', () => {
    expect(serviceAuthFromEnv({})).toBeUndefined();
    expect(
      serviceAuthFromEnv({ FACTORY_FLOOR_AGENT_TO_FACTORY_KEY: 'agent-key' }),
    ).toBeUndefined();
  });
});

describe('sign and verify', () => {
  it('signs and verifies a valid request', async () => {
    const config = testConfig();
    const now = Date.now();

    const { keyId, timestamp, nonce, signature } = signRequest(
      config.keys,
      'POST',
      '/api/v1/discord/activity/sessions',
      { instanceId: 'test' },
      now,
    );

    const header = signatureHeader(keyId, timestamp, nonce, signature);
    expect(header).toContain('HMAC-SHA256');
    expect(header).toContain(`keyId=${keyId}`);
    expect(header).toContain(`timestamp=${timestamp}`);

    // This should not throw
    await verifyServiceRequest(
      { keys: config.keys, db: config.nonceDb, maxSkewMs: 30_000 },
      'POST',
      '/api/v1/discord/activity/sessions',
      { instanceId: 'test' },
      header,
      now,
    );

    expect(config.nonceDb.isNonceUsed).toHaveBeenCalledWith(keyId, nonce);
    expect(config.nonceDb.recordNonce).toHaveBeenCalledWith(keyId, nonce);
  });

  it('rejects missing auth header', async () => {
    const config = testConfig();
    await expect(
      verifyServiceRequest(
        { keys: config.keys, db: config.nonceDb },
        'GET',
        '/health',
        null,
        undefined,
      ),
    ).rejects.toThrow(ServiceAuthError);
  });

  it('rejects malformed auth header', async () => {
    const config = testConfig();
    await expect(
      verifyServiceRequest(
        { keys: config.keys, db: config.nonceDb },
        'GET',
        '/health',
        null,
        'Bearer some-token',
      ),
    ).rejects.toThrow(ServiceAuthError);
  });

  it('rejects unknown key ID', async () => {
    const config = testConfig();
    const header = signatureHeader('unknown-key', String(Date.now()), 'nonce-1', 'sig');
    await expect(
      verifyServiceRequest(
        { keys: config.keys, db: config.nonceDb },
        'GET',
        '/health',
        null,
        header,
      ),
    ).rejects.toThrow(ServiceAuthError);
  });

  it('rejects stale timestamp beyond skew', async () => {
    const config = testConfig();
    const now = Date.now();
    const stale = now - 120_000;

    const { keyId, timestamp, nonce, signature } = signRequest(
      config.keys,
      'GET',
      '/health',
      null,
      stale,
    );

    const header = signatureHeader(keyId, timestamp, nonce, signature);
    await expect(
      verifyServiceRequest(
        { keys: config.keys, db: config.nonceDb, maxSkewMs: 30_000 },
        'GET',
        '/health',
        null,
        header,
        now,
      ),
    ).rejects.toThrow(ServiceAuthError);
  });

  it('rejects replayed nonce', async () => {
    const config = testConfig();
    const now = Date.now();

    const { keyId, timestamp, nonce, signature } = signRequest(
      config.keys,
      'POST',
      '/api/v1/discord/activity/sessions',
      { test: true },
      now,
    );

    const header = signatureHeader(keyId, timestamp, nonce, signature);

    config.nonceDb.isNonceUsed.mockResolvedValueOnce(false);
    config.nonceDb.recordNonce.mockResolvedValueOnce(undefined);

    await verifyServiceRequest(
      { keys: config.keys, db: config.nonceDb, maxSkewMs: 30_000 },
      'POST',
      '/api/v1/discord/activity/sessions',
      { test: true },
      header,
      now,
    );

    config.nonceDb.isNonceUsed.mockResolvedValueOnce(true);
    await expect(
      verifyServiceRequest(
        { keys: config.keys, db: config.nonceDb, maxSkewMs: 30_000 },
        'POST',
        '/api/v1/discord/activity/sessions',
        { test: true },
        header,
        now,
      ),
    ).rejects.toThrow(ServiceAuthError);
  });

  it('rejects signature mismatch from wrong body', async () => {
    const config = testConfig();
    const now = Date.now();

    const { keyId, timestamp, nonce, signature } = signRequest(
      config.keys,
      'POST',
      '/api/v1/discord/activity/sessions',
      { realBody: true },
      now,
    );

    const header = signatureHeader(keyId, timestamp, nonce, signature);

    await expect(
      verifyServiceRequest(
        { keys: config.keys, db: config.nonceDb, maxSkewMs: 30_000 },
        'POST',
        '/api/v1/discord/activity/sessions',
        { fakeBody: true },
        header,
        now,
      ),
    ).rejects.toThrow(ServiceAuthError);
  });

  it('rejects signature mismatch from wrong method', async () => {
    const config = testConfig();
    const now = Date.now();

    const { keyId, timestamp, nonce, signature } = signRequest(
      config.keys,
      'POST',
      '/api/v1/discord/activity/sessions',
      { test: true },
      now,
    );

    const header = signatureHeader(keyId, timestamp, nonce, signature);

    await expect(
      verifyServiceRequest(
        { keys: config.keys, db: config.nonceDb, maxSkewMs: 30_000 },
        'GET',
        '/api/v1/discord/activity/sessions',
        { test: true },
        header,
        now,
      ),
    ).rejects.toThrow(ServiceAuthError);
  });

  it('rejects signature mismatch from wrong path', async () => {
    const config = testConfig();
    const now = Date.now();

    const { keyId, timestamp, nonce, signature } = signRequest(
      config.keys,
      'POST',
      '/api/v1/discord/activity/sessions',
      { test: true },
      now,
    );

    const header = signatureHeader(keyId, timestamp, nonce, signature);

    await expect(
      verifyServiceRequest(
        { keys: config.keys, db: config.nonceDb, maxSkewMs: 30_000 },
        'POST',
        '/api/v1/discord/activity/other',
        { test: true },
        header,
        now,
      ),
    ).rejects.toThrow(ServiceAuthError);
  });

  it('accepts requests signed with previous key during rotation', async () => {
    const config = testConfig();
    const now = Date.now();

    const { keyId, timestamp, nonce, signature } = signRequest(
      {
        agentToFactoryKey: testKeys().agentToFactoryKey,
        factoryToAgentKey: 'new-factory-key',
      },
      'GET',
      '/health',
      null,
      now,
    );

    const header = signatureHeader(keyId, timestamp, nonce, signature);

    await expect(
      verifyServiceRequest(
        {
          keys: {
            agentToFactoryKey: testKeys().agentToFactoryKey,
            factoryToAgentKey: 'new-factory-key',
            previousAgentToFactoryKey: testKeys().agentToFactoryKey,
          },
          db: config.nonceDb,
          maxSkewMs: 30_000,
        },
        'GET',
        '/health',
        null,
        header,
        now,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('parseSignatureHeader', () => {
  it('parses a valid header', () => {
    const result = parseSignatureHeader(
      'HMAC-SHA256 keyId=ff-agent-to-ff-v1,timestamp=12345,nonce=abc,signature=def',
    );
    expect(result).toEqual({
      keyId: 'ff-agent-to-ff-v1',
      timestamp: '12345',
      nonce: 'abc',
      signature: 'def',
    });
  });

  it('returns null for invalid format', () => {
    expect(parseSignatureHeader('invalid')).toBeNull();
    expect(parseSignatureHeader('HMAC-SHA256 keyId=only')).toBeNull();
  });
});

describe('ServiceAuthError', () => {
  it('carries the message and status code', () => {
    const err = new ServiceAuthError('test_error', 403);
    expect(err.message).toBe('test_error');
    expect(err.statusCode).toBe(403);
    expect(err.name).toBe('ServiceAuthError');
  });
});
