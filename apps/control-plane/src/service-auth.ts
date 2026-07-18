import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createUuidV7 } from '@factory-floor/db';

const SIGNATURE_VERSION = '1';
const MAX_SKEW_MS = 30_000;
const MAX_NONCE_LENGTH = 128;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;
const TIMESTAMP_PATTERN = /^\d{1,16}$/;

export type ServiceAuthDirection = 'agent-to-ff' | 'ff-to-agent';
export type ServiceAuthBody = string | Uint8Array;

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
    consumeNonce: (
      keyId: string,
      nonce: string,
      now?: number,
    ) => Promise<boolean>;
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

function keyId(direction: ServiceAuthDirection): string {
  return `ff-${direction}-v1`;
}

function currentKey(
  keys: ServiceAuthKeys,
  direction: ServiceAuthDirection,
): string {
  return direction === 'agent-to-ff'
    ? keys.agentToFactoryKey
    : keys.factoryToAgentKey;
}

function verificationKeys(
  keys: ServiceAuthKeys,
  direction: ServiceAuthDirection,
): string[] {
  const previous =
    direction === 'agent-to-ff'
      ? keys.previousAgentToFactoryKey
      : keys.previousFactoryToAgentKey;
  return previous ? [currentKey(keys, direction), previous] : [currentKey(keys, direction)];
}

function bodyBuffer(body: ServiceAuthBody): Buffer {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
}

function signaturePayload(
  direction: ServiceAuthDirection,
  timestamp: string,
  nonce: string,
  method: string,
  path: string,
  body: ServiceAuthBody,
): string {
  return [
    SIGNATURE_VERSION,
    keyId(direction),
    timestamp,
    nonce,
    method.toUpperCase(),
    path,
    createHash('sha256').update(bodyBuffer(body)).digest('hex'),
  ].join('\n');
}

export function signRequest(
  keys: ServiceAuthKeys,
  direction: ServiceAuthDirection,
  method: string,
  path: string,
  body: ServiceAuthBody,
  now = Date.now(),
  nonce = createUuidV7(now),
): { keyId: string; timestamp: string; nonce: string; signature: string } {
  const timestamp = String(now);
  const kId = keyId(direction);
  const signature = createHmac('sha256', currentKey(keys, direction))
    .update(signaturePayload(direction, timestamp, nonce, method, path, body))
    .digest('hex');

  return { keyId: kId, timestamp, nonce, signature };
}

export function signatureHeader(
  signingKeyId: string,
  timestamp: string,
  nonce: string,
  signature: string,
): string {
  return `HMAC-SHA256 keyId=${signingKeyId},timestamp=${timestamp},nonce=${nonce},signature=${signature}`;
}

export function parseSignatureHeader(
  header: string,
): {
  keyId: string;
  timestamp: string;
  nonce: string;
  signature: string;
} | null {
  const match = /^HMAC-SHA256\s+keyId=([^,]+),timestamp=([^,]+),nonce=([^,]+),signature=([^,]+)$/.exec(
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
  direction: ServiceAuthDirection,
  method: string,
  path: string,
  body: ServiceAuthBody,
  signatureHeaderValue: string | undefined,
  now = Date.now(),
): Promise<void> {
  if (!signatureHeaderValue)
    throw new ServiceAuthError('service_auth_header_required');

  const parsed = parseSignatureHeader(signatureHeaderValue);
  if (!parsed)
    throw new ServiceAuthError('service_auth_header_malformed');

  const { keyId: suppliedKeyId, timestamp, nonce, signature } = parsed;
  if (suppliedKeyId !== keyId(direction))
    throw new ServiceAuthError('service_auth_unknown_key');

  if (!TIMESTAMP_PATTERN.test(timestamp))
    throw new ServiceAuthError('service_auth_invalid_timestamp');
  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber))
    throw new ServiceAuthError('service_auth_invalid_timestamp');

  const skew = Math.abs(now - timestampNumber);
  const maxSkew = config.maxSkewMs ?? MAX_SKEW_MS;
  if (skew > maxSkew)
    throw new ServiceAuthError('service_auth_timestamp_skew');

  if (nonce.trim() === '')
    throw new ServiceAuthError('service_auth_nonce_required');
  if (nonce.length > MAX_NONCE_LENGTH)
    throw new ServiceAuthError('service_auth_nonce_too_long');
  if (!SIGNATURE_PATTERN.test(signature))
    throw new ServiceAuthError('service_auth_signature_mismatch');

  const payload = signaturePayload(
    direction,
    timestamp,
    nonce,
    method,
    path,
    body,
  );
  const suppliedSignature = Buffer.from(signature, 'hex');
  let matched = false;
  for (const key of verificationKeys(config.keys, direction)) {
    const expectedSignature = createHmac('sha256', key).update(payload).digest();
    const candidateMatches =
      suppliedSignature.length === expectedSignature.length &&
      timingSafeEqual(suppliedSignature, expectedSignature);
    matched = matched || candidateMatches;
  }
  if (!matched)
    throw new ServiceAuthError('service_auth_signature_mismatch');

  if (!(await config.db.consumeNonce(suppliedKeyId, nonce, now)))
    throw new ServiceAuthError('service_auth_nonce_replayed');
}

export function registerServiceAuth(
  app: FastifyInstance,
  config: ServiceAuthConfig,
): void {
  const defaultJsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
      request.serviceAuthRawBody = rawBody;
      defaultJsonParser(request, rawBody.toString('utf8'), done);
    },
  );
  app.decorate('serviceAuthConfig', config);
}

declare module 'fastify' {
  interface FastifyInstance {
    serviceAuthConfig?: ServiceAuthConfig;
  }

  interface FastifyRequest {
    serviceAuthRawBody?: Buffer;
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
