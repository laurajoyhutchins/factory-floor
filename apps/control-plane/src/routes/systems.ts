/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import {
  isDomainError,
  type SystemApplicationService,
} from '@factory-floor/runtime-core';
export async function registerSystemRoutes(
  app: FastifyInstance,
  svc: SystemApplicationService,
) {
  app.post('/api/v1/systems/apply', async (request: any, reply: any) => {
    try {
      const r = await svc.apply(request.body);
      return reply.code(r.disposition === 'created' ? 201 : 200).send(r);
    } catch (e) {
      if (isDomainError(e))
        return reply
          .code(e.code.includes('conflict') ? 409 : 422)
          .send({ error: { code: e.code, message: e.message } });
      return reply
        .code(500)
        .send({
          error: { code: 'internal_error', message: 'Unexpected error' },
        });
    }
  });
}
