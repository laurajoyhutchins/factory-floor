/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import {
  isDomainError,
  type RegistrationService,
} from '@factory-floor/runtime-core';
function mapError(error: unknown) {
  if (isDomainError(error))
    return {
      statusCode: error.code.includes('conflict') ? 409 : 422,
      body: { error: { code: error.code, message: error.message } },
    };
  return {
    statusCode: 500,
    body: { error: { code: 'internal_error', message: 'Unexpected error' } },
  };
}
export async function registerRegistrationRoutes(
  app: FastifyInstance,
  svc: RegistrationService,
) {
  const handler =
    (fn: (body: any) => Promise<any>) => async (request: any, reply: any) => {
      try {
        const result = await fn(request.body);
        return reply.code(result.disposition === 'created' ? 201 : 200).send({
          disposition: result.disposition,
          digest: result.digest,
          entity: result.entity,
        });
      } catch (e) {
        const m = mapError(e);
        return reply.code(m.statusCode).send(m.body);
      }
    };
  app.post(
    '/api/v1/registrations/artifact-schemas',
    handler((b) => svc.registerArtifactSchema(b)),
  );
  app.post(
    '/api/v1/registrations/component-definitions',
    handler((b) => svc.registerComponentDefinition(b)),
  );
  app.post(
    '/api/v1/registrations/templates',
    handler((b) => svc.registerTemplate(b)),
  );
  app.post(
    '/api/v1/registrations/policies',
    handler((b) => svc.registerPolicy(b)),
  );
}
