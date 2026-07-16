import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import {
  WorkerProtocolError,
  type WorkerProtocolService,
} from '@factory-floor/runtime-core';

const protocolVersion = '1.0';
const contractRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../contracts/schemas',
);
const contractId = (name: string) =>
  `https://factory-floor.local/contracts/${name}.schema.json`;

export interface WorkerAuthorization {
  workers: Record<
    string,
    {
      token: string;
      capabilities: string[];
    }
  >;
}

export function workerAuthorizationFromEnv(
  env: Record<string, string | undefined>,
): WorkerAuthorization {
  const encoded = env.WORKER_AUTHORIZATION_JSON?.trim();
  if (encoded) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      throw new Error('WORKER_AUTHORIZATION_JSON must be valid JSON');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    )
      throw new Error('WORKER_AUTHORIZATION_JSON must be an object');
    const workers: WorkerAuthorization['workers'] = {};
    for (const [workerId, value] of Object.entries(parsed)) {
      if (
        !workerId.trim() ||
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value)
      )
        throw new Error('worker authorization entries are invalid');
      const entry = value as { token?: unknown; capabilities?: unknown };
      if (
        typeof entry.token !== 'string' ||
        !entry.token.trim() ||
        !Array.isArray(entry.capabilities) ||
        !entry.capabilities.every(
          (capability) => typeof capability === 'string' && capability.trim(),
        )
      )
        throw new Error('worker authorization entries are invalid');
      const capabilities = entry.capabilities as string[];
      workers[workerId] = {
        token: entry.token,
        capabilities: [...new Set(capabilities)],
      };
    }
    if (Object.keys(workers).length === 0)
      throw new Error('WORKER_AUTHORIZATION_JSON must authorize a worker');
    return { workers };
  }

  const configuredWorkerId = env.FACTORY_FLOOR_WORKER_ID?.trim();
  const token = env.WORKER_API_BEARER_TOKEN?.trim();
  const capabilities = env.FACTORY_FLOOR_WORKER_CAPABILITIES?.split(',')
    .map((capability) => capability.trim())
    .filter(Boolean);
  if (!configuredWorkerId || !token || !capabilities?.length)
    throw new Error(
      'configure WORKER_AUTHORIZATION_JSON or FACTORY_FLOOR_WORKER_ID, WORKER_API_BEARER_TOKEN, and FACTORY_FLOOR_WORKER_CAPABILITIES',
    );
  return {
    workers: {
      '*': { token, capabilities },
    },
  };
}

function protocolSchemas(): Record<string, unknown>[] {
  return readdirSync(contractRoot, { recursive: true })
    .filter((name) => String(name).endsWith('.schema.json'))
    .sort()
    .map((name) =>
      JSON.parse(readFileSync(join(contractRoot, String(name)), 'utf8')),
    )
    .filter(
      (schema): schema is Record<string, unknown> =>
        typeof schema === 'object' &&
        schema !== null &&
        typeof schema.$id === 'string',
    )
    .map((schema) => {
      const runtimeSchema = { ...schema };
      delete runtimeSchema.$schema;
      return runtimeSchema;
    });
}

function authError(requestId: string, message: string) {
  return {
    protocolVersion,
    code: 'authentication_failure',
    message,
    retryable: false,
    requestId,
  };
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1];
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function requestProtocolVersion(request: FastifyRequest): unknown {
  const candidate = request.method === 'PUT' ? request.query : request.body;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  return (candidate as Record<string, unknown>).protocolVersion;
}

function isReadable(value: unknown): value is Readable {
  return (
    value instanceof Readable ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { pipe?: unknown }).pipe === 'function')
  );
}

function workerError(
  requestId: string,
  code: string,
  message: string,
  retryable: boolean,
) {
  return { protocolVersion, code, message, retryable, requestId };
}

export async function registerWorkerRoutes(
  app: FastifyInstance,
  service: WorkerProtocolService,
  authorization: string | WorkerAuthorization | undefined =
    process.env.WORKER_API_BEARER_TOKEN,
): Promise<void> {
  const authenticatedWorkers = new WeakMap<FastifyRequest, string[]>();
  await app.register(
    async (workerApp) => {
      for (const schema of protocolSchemas()) workerApp.addSchema(schema);

      workerApp.addContentTypeParser(
        'application/octet-stream',
        (_request, payload, done) => done(null, payload),
      );

      workerApp.addHook('onRequest', async (request, reply) => {
        const value = bearer(request);
        if (!value)
          return reply
            .code(401)
            .send(authError(request.id, 'missing worker bearer token'));
        if (typeof authorization === 'string') {
          if (!tokenMatches(value, authorization))
            return reply
              .code(403)
              .send(authError(request.id, 'invalid worker bearer token'));
          return;
        }
        const workerIds = Object.entries(authorization?.workers ?? {})
          .filter(([, entry]) => tokenMatches(value, entry.token))
          .map(([workerId]) => workerId);
        if (workerIds.length === 0)
          return reply
            .code(403)
            .send(authError(request.id, 'invalid worker bearer token'));
        authenticatedWorkers.set(request, workerIds);
      });

      workerApp.addHook('preValidation', async (request) => {
        const version = requestProtocolVersion(request);
        if (version !== undefined && version !== protocolVersion)
          throw new WorkerProtocolError(
            'unsupported_protocol_version',
            'protocolVersion must be 1.0',
            false,
            400,
          );
      });

      workerApp.setErrorHandler((error: FastifyError, request, reply) => {
        if (error instanceof WorkerProtocolError)
          return reply
            .code(error.statusCode)
            .send(
              workerError(
                request.id,
                error.code,
                error.message,
                error.retryable,
              ),
            );
        if (error.validation) {
          request.log.warn(
            { validation: error.validation },
            'worker request validation failed',
          );
          return reply
            .code(400)
            .send(
              workerError(
                request.id,
                'invalid_request',
                'request did not match the worker protocol schema',
                false,
              ),
            );
        }
        request.log.error({ err: error }, 'worker route failed');
        return reply
          .code(500)
          .send(
            workerError(
              request.id,
              'internal_transient_failure',
              'internal worker protocol failure',
              true,
            ),
          );
      });

      workerApp.post(
        '/claim',
        { schema: { body: { $ref: contractId('worker/claim-request') } } },
        async (request) => {
          const input = request.body as Parameters<
            WorkerProtocolService['claim']
          >[0] & { protocolVersion?: string };
          if (typeof authorization !== 'string') {
            const workerIds = authenticatedWorkers.get(request) ?? [];
            const exact = workerIds.includes(input.workerId)
              ? authorization?.workers[input.workerId]
              : undefined;
            const wildcard = workerIds.includes('*')
              ? authorization?.workers['*']
              : undefined;
            const allowed = exact ?? wildcard;
            if (!allowed)
              throw new WorkerProtocolError(
                'capability_denied',
                'worker token is not authorized for this worker identity',
                false,
                403,
              );
            const delegated = new Set(allowed.capabilities);
            if (
              input.capabilities.some(
                (capability) => !delegated.has(capability),
              )
            )
              throw new WorkerProtocolError(
                'capability_denied',
                'worker requested an undelegated component selector',
                false,
                403,
              );
          }
          return service.claim(input);
        },
      );
      workerApp.post(
        '/heartbeat',
        { schema: { body: { $ref: contractId('worker/heartbeat') } } },
        async (request) =>
          service.heartbeat(
            request.body as Parameters<WorkerProtocolService['heartbeat']>[0],
          ),
      );
      workerApp.post(
        '/cancellation',
        { schema: { body: { $ref: contractId('worker/heartbeat') } } },
        async (request) =>
          service.cancellation(
            request.body as Parameters<
              WorkerProtocolService['cancellation']
            >[0],
          ),
      );
      workerApp.post(
        '/artifacts/stage',
        { schema: { body: { $ref: contractId('worker/stage-request') } } },
        async (request) =>
          service.stage(
            request.body as Parameters<WorkerProtocolService['stage']>[0],
          ),
      );
      workerApp.put(
        '/artifacts/upload/:stagedRef',
        {
          schema: {
            params: {
              type: 'object',
              additionalProperties: false,
              properties: {
                stagedRef: { type: 'string', format: 'uuid' },
              },
              required: ['stagedRef'],
            },
            querystring: { $ref: contractId('worker/heartbeat') },
          },
        },
        async (request) => {
          if (!isReadable(request.body))
            throw new WorkerProtocolError(
              'invalid_request',
              'artifact upload body must be application/octet-stream',
              false,
              400,
            );
          return service.upload(
            (request.params as { stagedRef: string }).stagedRef,
            request.query as Parameters<WorkerProtocolService['upload']>[1],
            request.body,
          );
        },
      );
      workerApp.post(
        '/results',
        { schema: { body: { $ref: contractId('proposed-result') } } },
        async (request) =>
          service.submitResult(
            request.body as Parameters<
              WorkerProtocolService['submitResult']
            >[0],
          ),
      );
      workerApp.post(
        '/capabilities/invoke',
        { schema: { body: { $ref: contractId('worker/capability-request') } } },
        async (request) =>
          service.invokeCapability(
            request.body as Parameters<
              WorkerProtocolService['invokeCapability']
            >[0],
          ),
      );
    },
    { prefix: '/worker/v1' },
  );
}
