import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { signRequest, type ServiceAuthDirection } from '../src/service-auth.js';

const EXPECTED_FIXTURE_DIGEST = '22c7499456e0bd1d4a1aaa8541e926b3f6778e06d678906311751a9c11ee2fd0';

interface ServiceAuthVector {
  name: string;
  direction: ServiceAuthDirection;
  key: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
  keyId: string;
  bodySha256: string;
  signature: string;
}

interface ServiceAuthFixture {
  schemaVersion: number;
  protocol: string;
  signatureVersion: string;
  vectors: ServiceAuthVector[];
}

const fixtureUrl = new URL('../../../contracts/discord-activity/service-auth-v1.json', import.meta.url);
const fixtureBytes = readFileSync(fixtureUrl);
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as ServiceAuthFixture;

function keysFor(vector: ServiceAuthVector) {
  return vector.direction === 'agent-to-ff'
    ? {
        agentToFactoryKey: vector.key,
        factoryToAgentKey: 'factory-other-direction-key',
      }
    : {
        agentToFactoryKey: 'agent-other-direction-key',
        factoryToAgentKey: vector.key,
      };
}

describe('Discord Activity service-auth contract fixture', () => {
  it('has the shared versioned digest', () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(
      EXPECTED_FIXTURE_DIGEST,
    );
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      protocol: 'factory-floor-service-auth',
      signatureVersion: '1',
    });
  });

  it.each(fixture.vectors)('matches $name', vector => {
    const signed = signRequest(
      keysFor(vector),
      vector.direction,
      vector.method,
      vector.path,
      vector.body,
      Number(vector.timestamp),
      vector.nonce,
    );

    expect(createHash('sha256').update(vector.body).digest('hex')).toBe(
      vector.bodySha256,
    );
    expect(signed).toEqual({
      keyId: vector.keyId,
      timestamp: vector.timestamp,
      nonce: vector.nonce,
      signature: vector.signature,
    });
  });
});
