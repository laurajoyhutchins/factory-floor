import type { FastifyInstance } from 'fastify';
import type { Json } from '@factory-floor/db';
import {
  CommandConflictError,
  type CommandService,
} from '@factory-floor/runtime-core';

interface CommandRequestBody {
  region: string;
  commandType: string;
  source?: Json;
  payload?: Json;
  correlationId?: string;
  idempotencyKey?: string;
  expiresAt?: string;
}

function isCommandRequestBody(value: unknown): value is CommandRequestBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const body = value as Record<string, unknown>;
  if (typeof body.region !== 'string' || body.region.trim() === '') return false;
  if (typeof body.commandType !== 'string' || body.commandType.trim() === '')
    return false;
  for (const field of ['correlationId', 'idempotencyKey', 'expiresAt'] as const)
    if (body[field] !== undefined && typeof body[field] !== 'string')
      return false;
  return true;
}

export async function registerCommandRoutes(
  app: FastifyInstance,
  service: CommandService,
) {
  app.post('/api/v1/commands', async (request, reply) => {
    if (!isCommandRequestBody(request.body))
      return reply.code(400).send({
        error: { code: 'bad_request', message: 'Malformed command request' },
      });

    const body = request.body;
    try {
      const result = await service.submit({
        region: body.region,
        commandType: body.commandType,
        source: body.source ?? {},
        payload: body.payload ?? {},
        correlationId: body.correlationId,
        idempotencyKey: body.idempotencyKey,
        expiresAt: body.expiresAt,
      });
      const status =
        result.disposition === 'replayed'
          ? 200
          : result.disposition === 'rejected'
            ? 422
            : 202;
      return reply.code(status).send(result);
    } catch (error) {
      if (error instanceof CommandConflictError)
        return reply.code(409).send({
          error: { code: error.code, message: error.message },
        });
      if ((error as Error).message === 'region_not_found')
        return reply.code(404).send({
          error: { code: 'region_not_found', message: 'Unknown region' },
        });
      if (
        (error as Error).message === 'commandType is required' ||
        (error as Error).message === 'expiresAt must be a valid timestamp'
      )
        return reply.code(400).send({
          error: { code: 'bad_request', message: (error as Error).message },
        });
      request.log.error(error);
      return reply.code(500).send({
        error: { code: 'internal_error', message: 'Internal error' },
      });
    }
  });
}
