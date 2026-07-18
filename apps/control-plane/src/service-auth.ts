import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createUuidV7 } from '@factory-floor/db';

const SIGNATURE_VERSION = '1';
const MAX_SKEW_MS = 30_000;
const MAX_NONCE_LENGTH = 128;

export interface ServiceAuthKeys {
  agentToFactoryKey: string;
  factoryToAgentKey: string;
  previousAgentToFactoryKey?: string;
  previousFactoryToAgentKey?: string;
}

export interface ServiceAuthConfig {
  keys: ServiceAuthKeys;
  maxSkewMs?: number;
  db: {
    isNonceUsed: (keyId: string, nonce: string) => Promise<boolean>;
    recordNonce: (keyId: string, nonce: string) => Promise<void>;
  };
}

export class ServiceAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 401,
  ) {
    super(message);
    this.name = 'ServiceAuthError';
  }
}

function keyId(direction: string): string {
  return `ff-${direction}-v1`;
}

function signingKey(
  keys: ServiceAuthKeys,
  direction: 'agent-to-ff' | 'ff-to-agent',
  keyIdToMatch: string,
): string | undefined {
  const candidates: Array<{ id: string; key: string }> = [
    { id: keyId('agent-to-ff'), key: keys.agentToFactoryKey },
    ...(keys.previousAgentToFactoryKey
      ? [
          {
            id: `${keyId('agent-to-ff')}-prev`,
            key: keys.previousAgentToFactoryKey,
          },
        ]
      : []),
    { id: keyId('ff-to-agent'), key: keys.factoryToAgentKey },
    ...(keys.previousFactoryToAgentKey
      ? [
          {
            id: `${keyId('ff-to-agent')}-prev`,
            key: keys.previousFactoryToAgentKey,
          },
        ]
      : []),
  ];
  const match = candidates.find((c) => c.id === keyIdToMatch && c.key);
  if (match && direction === 'agent-to-ff')
    return match.key;
  if (match && direction === 'ff-to-agent')
    return match.key;
  return undefined;
}

function canonicalBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

export function signRequest(
  keys: ServiceAuthKeys,
  method: string,
  path: string,
  body: unknown,
  now = Date.now(),
): { keyId: string; timestamp: string; nonce: string; signature: string } {
  const timestamp = String(now);
  const nonce = createUuidV7(now);
  const bodyStr = canonicalBody(body);
  const directionKey = keys.factoryToAgentKey;
  const kId = keyId('ff-to-agent');

  const payload = [
    SIGNATURE_VERSION,
    kId,
    timestamp,
    nonce,
    method.toUpperCase(),
    path,
    createHash('sha256').update(bodyStr).digest('hex'),
  ].join('\n');

  const signature = createHmac('sha256', directionKey)
    .update(payload)
    .digest('hex');

  return { keyId: kId, timestamp, nonce, signature };
}

export function signatureHeader(
  keyId: string,
  timestamp: string,
  nonce: string,
  signature: string,
): string {
  return `HMAC-SHA256 keyId=${keyId},timestamp=${timestamp},nonce=${nonce},signature=${signature}`;
}

export function parseSignatureHeader(
  header: string,
): {
  keyId: string;
  timestamp: string;
  nonce: string;
  signature: string;
} | null {
  const match = /^HMAC-SHA256\s+keyId=([^,]+),timestamp=([^,]+),nonce=([^,]+),signature=(.+)$/.exec(
    header,
  );
  if (!match) return null;
  return {
    keyId: match[1],
    timestamp: match[2],
    nonce: match[3],
    signature: match[4],
  };
}

export async function verifyServiceRequest(
  config: ServiceAuthConfig,
  method: string,
  path: string,
  body: unknown,
  signatureHeaderValue: string | undefined,
  now = Date.now(),
): Promise<void> {
  if (!signatureHeaderValue)
    throw new ServiceAuthError('service_auth_header_required');

  const parsed = parseSignatureHeader(signatureHeaderValue);
  if (!parsed)
    throw new ServiceAuthError('service_auth_header_malformed');

  const { keyId: kId, timestamp, nonce, signature } = parsed;

  const key = signingKey(
    config.keys,
    'agent-to-ff',
    kId,
  );
  if (!key)
    throw new ServiceAuthError('service_auth_unknown_key');

  const timestampNum = Number(timestamp);
  if (!Number.isFinite(timestampNum))
    throw new ServiceAuthError('service_auth_invalid_timestamp');

  const skew = Math.abs(now - timestampNum);
  const maxSkew = config.maxSkewMs ?? MAX_SKEW_MS;
  if (skew > maxSkew)
    throw new ServiceAuthError('service_auth_timestamp_skew');

  if (nonce.length > MAX_NONCE_LENGTH)
    throw new ServiceAuthError('service_auth_nonce_too_long');

  if (await config.db.isNonceUsed(kId, nonce))
    throw new ServiceAuthError('service_auth_nonce_replayed');

  const bodyStr = canonicalBody(body);
  const payload = [
    SIGNATURE_VERSION,
    kId,
    timestamp,
    nonce,
    method.toUpperCase(),
    path,
    createHash('sha256').update(bodyStr).digest('hex'),
  ].join('\n');

  const expectedSignature = createHmac('sha256', key)
    .update(payload)
    .digest('hex');

  if (
    !timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    )
  )
    throw new ServiceAuthError('service_auth_signature_mismatch');

  await config.db.recordNonce(kId, nonce);
}

export function registerServiceAuth(
  app: FastifyInstance,
  config: ServiceAuthConfig,
): void {
  app.decorate('serviceAuthConfig', config);
}

declare module 'fastify' {
  interface FastifyInstance {
    serviceAuthConfig?: ServiceAuthConfig;
  }
}

export function serviceAuthFromEnv(
  env: Record<string, string | undefined>,
): ServiceAuthKeys | undefined {
  const agentToFactoryKey = env.FACTORY_FLOOR_AGENT_TO_FACTORY_KEY?.trim();
  const factoryToAgentKey = env.FACTORY_FLOOR_FACTORY_TO_AGENT_KEY?.trim();
  if (!agentToFactoryKey || !factoryToAgentKey) return undefined;

  return {
    agentToFactoryKey,
    factoryToAgentKey,
    previousAgentToFactoryKey:
      env.FACTORY_FLOOR_PREVIOUS_AGENT_TO_FACTORY_KEY?.trim() || undefined,
    previousFactoryToAgentKey:
      env.FACTORY_FLOOR_PREVIOUS_FACTORY_TO_AGENT_KEY?.trim() || undefined,
  };
}
