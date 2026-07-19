import { describe, expect, it, vi } from 'vitest';
import {
  ServiceAuthError,
  parseSignatureHeader,
  serviceAuthFromEnv,
  signRequest,
  signatureHeader,
  verifyServiceRequest,
  type ServiceAuthDirection,
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
    consumeNonce: vi.fn(async (keyId: string, nonce: string) => {
      const value = `${keyId}:${nonce}`;
      if (used.has(value)) return false;
      used.add(value);
      return true;
    }),
  };
}

function signedHeader(
  direction: ServiceAuthDirection,
  method: string,
  path: string,
  body: string,
  now: number,
  keys = testKeys(),
): string {
  const signed = signRequest(keys, direction, method, path, body, now);
  return signatureHeader(
    signed.keyId,
    signed.timestamp,
    signed.nonce,
    signed.signature,
  );
}

function testConfig() {
  return {
    keys: testKeys(),
    db: testNonceDb(),
    maxSkewMs: 30_000,
  };
}

describe('service auth from env', () => {
  it('loads current and previous directional keys', () => {
    expect(
      serviceAuthFromEnv({
        FACTORY_FLOOR_AGENT_TO_FACTORY_KEY: 'agent-key',
        FACTORY_FLOOR_FACTORY_TO_AGENT_KEY: 'factory-key',
        FACTORY_FLOOR_PREVIOUS_AGENT_TO_FACTORY_KEY: 'old-agent-key',
        FACTORY_FLOOR_PREVIOUS_FACTORY_TO_AGENT_KEY: 'old-factory-key',
      }),
    ).toEqual({
      agentToFactoryKey: 'agent-key',
      factoryToAgentKey: 'factory-key',
      previousAgentToFactoryKey: 'old-agent-key',
      previousFactoryToAgentKey: 'old-factory-key',
    });
  });

  it('returns undefined unless both current keys are configured', () => {
    expect(serviceAuthFromEnv({})).toBeUndefined();
    expect(
      serviceAuthFromEnv({ FACTORY_FLOOR_AGENT_TO_FACTORY_KEY: 'agent-key' }),
    ).toBeUndefined();
  });
});

describe('sign and verify', () => {
  it('verifies a valid agent-to-Factory-Floor request', async () => {
    const config = testConfig();
    const now = Date.now();
    const path = '/api/v1/discord/activity/sessions';
    const body = '{"instanceId":"test"}';
    const header = signedHeader('agent-to-ff', 'POST', path, body, now);

    await expect(
      verifyServiceRequest(
        config,
        'agent-to-ff',
        'POST',
        path,
        body,
        header,
        now,
      ),
    ).resolves.toBeUndefined();
    expect(config.db.consumeNonce).toHaveBeenCalledTimes(1);
  });

  it('does not accept the reverse-direction key', async () => {
    const config = testConfig();
    const now = Date.now();
    const body = '{}';
    const header = signedHeader(
      'ff-to-agent',
      'POST',
      '/api/v1/discord/activity/sessions',
      body,
      now,
    );

    await expect(
      verifyServiceRequest(
        config,
        'agent-to-ff',
        'POST',
        '/api/v1/discord/activity/sessions',
        body,
        header,
        now,
      ),
    ).rejects.toMatchObject({ message: 'service_auth_unknown_key' });
    expect(config.db.consumeNonce).not.toHaveBeenCalled();
  });

  it('accepts the previous key under the stable directional key ID', async () => {
    const oldKeys = {
      agentToFactoryKey: 'old-agent-key',
      factoryToAgentKey: 'factory-key',
    };
    const config = {
      keys: {
        ...testKeys(),
        agentToFactoryKey: 'new-agent-key',
        previousAgentToFactoryKey: oldKeys.agentToFactoryKey,
      },
      db: testNonceDb(),
    };
    const now = Date.now();
    const header = signedHeader(
      'agent-to-ff',
      'POST',
      '/api/v1/discord/activity/sessions',
      '{}',
      now,
      oldKeys,
    );

    await expect(
      verifyServiceRequest(
        config,
        'agent-to-ff',
        'POST',
        '/api/v1/discord/activity/sessions',
        '{}',
        header,
        now,
      ),
    ).resolves.toBeUndefined();
  });

  it('signs exact body bytes rather than parsed JSON', async () => {
    const config = testConfig();
    const now = Date.now();
    const path = '/api/v1/discord/activity/sessions';
    const header = signedHeader(
      'agent-to-ff',
      'POST',
      path,
      '{"a":1,"b":2}',
      now,
    );

    await expect(
      verifyServiceRequest(
        config,
        'agent-to-ff',
        'POST',
        path,
        '{ "a": 1, "b": 2 }',
        header,
        now,
      ),
    ).rejects.toMatchObject({ message: 'service_auth_signature_mismatch' });
    expect(config.db.consumeNonce).not.toHaveBeenCalled();
  });

  it('rejects missing and malformed headers', async () => {
    const config = testConfig();
    await expect(
      verifyServiceRequest(
        config,
        'agent-to-ff',
        'GET',
        '/health',
        '',
        undefined,
      ),
    ).rejects.toBeInstanceOf(ServiceAuthError);
    await expect(
      verifyServiceRequest(
        config,
        'agent-to-ff',
        'GET',
        '/health',
        '',
        'Bearer token',
      ),
    ).rejects.toBeInstanceOf(ServiceAuthError);
  });

  it('rejects timestamps outside the skew window', async () => {
    const config = testConfig();
    const now = Date.now();
    const signedAt = now - 120_000;
    const header = signedHeader('agent-to-ff', 'GET', '/health', '', signedAt);

    await expect(
      verifyServiceRequest(
        config,
        'agent-to-ff',
        'GET',
        '/health',
        '',
        header,
        now,
      ),
    ).rejects.toMatchObject({ message: 'service_auth_timestamp_skew' });
  });

  it('rejects replayed nonces atomically', async () => {
    const config = testConfig();
    const now = Date.now();
    const path = '/api/v1/discord/activity/sessions';
    const header = signedHeader('agent-to-ff', 'POST', path, '{}', now);

    await verifyServiceRequest(
      config,
      'agent-to-ff',
      'POST',
      path,
      '{}',
      header,
      now,
    );
    await expect(
      verifyServiceRequest(
        config,
        'agent-to-ff',
        'POST',
        path,
        '{}',
        header,
        now,
      ),
    ).rejects.toMatchObject({ message: 'service_auth_nonce_replayed' });
  });

  it('binds the signature to the method and normalized path', async () => {
    const config = testConfig();
    const now = Date.now();
    const path = '/api/v1/discord/activity/sessions';
    const header = signedHeader('agent-to-ff', 'POST', path, '{}', now);

    await expect(
      verifyServiceRequest(
        config,
        'agent-to-ff',
        'GET',
        path,
        '{}',
        header,
        now,
      ),
    ).rejects.toMatchObject({ message: 'service_auth_signature_mismatch' });
    await expect(
      verifyServiceRequest(
        config,
        'agent-to-ff',
        'POST',
        `${path}/other`,
        '{}',
        header,
        now,
      ),
    ).rejects.toMatchObject({ message: 'service_auth_signature_mismatch' });
  });

  it('rejects malformed signature encodings without throwing a buffer error', async () => {
    const config = testConfig();
    const header = signatureHeader(
      'ff-agent-to-ff-v1',
      String(Date.now()),
      'nonce',
      'not-hex',
    );
    await expect(
      verifyServiceRequest(
        config,
        'agent-to-ff',
        'POST',
        '/api/v1/discord/activity/sessions',
        '{}',
        header,
      ),
    ).rejects.toMatchObject({ message: 'service_auth_signature_mismatch' });
  });
});

describe('parseSignatureHeader', () => {
  it('parses the stable header format', () => {
    expect(
      parseSignatureHeader(
        'HMAC-SHA256 keyId=ff-agent-to-ff-v1,timestamp=12345,nonce=abc,signature=def',
      ),
    ).toEqual({
      keyId: 'ff-agent-to-ff-v1',
      timestamp: '12345',
      nonce: 'abc',
      signature: 'def',
    });
  });

  it('rejects incomplete or ambiguous headers', () => {
    expect(parseSignatureHeader('invalid')).toBeNull();
    expect(parseSignatureHeader('HMAC-SHA256 keyId=only')).toBeNull();
    expect(
      parseSignatureHeader(
        'HMAC-SHA256 keyId=a,timestamp=1,nonce=n,signature=s,extra=x',
      ),
    ).toBeNull();
  });
});
