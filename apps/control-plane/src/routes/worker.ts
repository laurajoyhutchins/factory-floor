/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WorkerProtocolError, type WorkerProtocolService } from '@factory-floor/runtime-core';

const protocolVersion = '1.0';
const authError = (requestId: string, message = 'worker authentication failed') => ({ protocolVersion, code: 'authentication_failure', message, retryable: false, requestId });
function bearer(request: FastifyRequest) { const header = request.headers.authorization; if (!header) return undefined; const m = /^Bearer (.+)$/.exec(header); return m?.[1]; }
function assertVersion(body: any) { if (body?.protocolVersion !== protocolVersion) throw new WorkerProtocolError('unsupported_protocol_version','protocolVersion must be 1.0',false,400); }
export async function registerWorkerRoutes(app: FastifyInstance, service: WorkerProtocolService, token = process.env.WORKER_API_BEARER_TOKEN): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/worker/v1')) return;
    const value = bearer(request);
    if (!value) return reply.code(401).send(authError(request.id, 'missing worker bearer token'));
    if (!token || value !== token) return reply.code(403).send(authError(request.id, 'invalid worker bearer token'));
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof WorkerProtocolError) return reply.code(error.statusCode).send({ protocolVersion, code: error.code, message: error.message, retryable: error.retryable, requestId: request.id });
    request.log.error({ err: error }, 'worker route failed');
    return reply.code(500).send({ protocolVersion, code: 'internal_transient_failure', message: 'internal worker protocol failure', retryable: true, requestId: request.id });
  });
  app.post('/worker/v1/claim', async (request) => { assertVersion(request.body); return service.claim(request.body as any); });
  app.post('/worker/v1/heartbeat', async (request) => { assertVersion(request.body); return service.heartbeat(request.body as any); });
  app.post('/worker/v1/cancellation', async (request) => { assertVersion(request.body); return service.cancellation(request.body as any); });
  app.post('/worker/v1/artifacts/stage', async (request) => { assertVersion(request.body); return service.stage(request.body as any); });
  app.put('/worker/v1/artifacts/upload/:stagedRef', async (request) => {
    const query = request.query as any; assertVersion(query);
    return service.upload((request.params as any).stagedRef, query, request.raw);
  });
  app.post('/worker/v1/results', async (request) => { assertVersion(request.body); return service.submitResult(request.body as any); });
  app.post('/worker/v1/capabilities/invoke', async (request) => { assertVersion(request.body); return service.invokeCapability(request.body as any); });
}
