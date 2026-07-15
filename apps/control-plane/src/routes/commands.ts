/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { CommandConflictError, type CommandService } from '@factory-floor/runtime-core';

export async function registerCommandRoutes(app: FastifyInstance, service: CommandService) {
  app.post('/api/v1/commands', async (request, reply) => {
    const body = request.body as any;
    if (!body || typeof body !== 'object' || typeof body.region !== 'string' || typeof body.commandType !== 'string') return reply.code(400).send({ error:{ code:'bad_request', message:'Malformed command request' } });
    try {
      const result = await service.submit({ region:body.region, commandType:body.commandType, source:body.source ?? {}, payload:body.payload ?? {}, correlationId:body.correlationId, idempotencyKey:body.idempotencyKey, expiresAt:body.expiresAt });
      const status = result.disposition === 'replayed' ? 200 : result.disposition === 'rejected' ? 422 : 202;
      return reply.code(status).send(result);
    } catch (error) {
      if (error instanceof CommandConflictError) return reply.code(409).send({ error:{ code:error.code, message:error.message } });
      if ((error as Error).message === 'region_not_found') return reply.code(404).send({ error:{ code:'region_not_found', message:'Unknown region' } });
      request.log.error(error); return reply.code(500).send({ error:{ code:'internal_error', message:'Internal error' } });
    }
  });
}
