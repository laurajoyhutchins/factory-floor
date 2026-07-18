import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ActivitySessionError,
  ActivitySessionService,
} from '../activity-session-service.js';
import {
  ServiceAuthError,
  verifyServiceRequest,
  type ServiceAuthConfig,
} from '../service-auth.js';

class RouteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  if (!isRecord(request.body))
    throw new RouteValidationError('malformed_request_body');
  return request.body;
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string' || result.trim() === '')
    throw new RouteValidationError(`${field}_required`);
  return result.trim();
}

function optionalString(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const result = value[field];
  return typeof result === 'string' && result.trim() !== ''
    ? result.trim()
    : undefined;
}

function serviceAuthHeader(request: FastifyRequest): string | undefined {
  const header = request.headers['x-factory-floor-service-auth'];
  return typeof header === 'string' ? header : undefined;
}

async function requireServiceAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  config: ServiceAuthConfig,
): Promise<boolean> {
  try {
    await verifyServiceRequest(
      config,
      'agent-to-ff',
      request.method,
      request.url.split('?', 1)[0] ?? request.url,
      request.serviceAuthRawBody ?? Buffer.alloc(0),
      serviceAuthHeader(request),
    );
    return true;
  } catch (error: unknown) {
    if (error instanceof ServiceAuthError) {
      await reply.code(error.statusCode).send({
        error: { code: error.message, message: error.message },
      });
      return false;
    }
    request.log.error(error);
    await reply.code(401).send({
      error: {
        code: 'service_auth_denied',
        message: 'Service authentication denied',
      },
    });
    return false;
  }
}

function parseCreateSessionRequest(request: FastifyRequest) {
  const body = bodyRecord(request);
  return {
    applicationId: requiredString(body, 'applicationId'),
    instanceId: requiredString(body, 'instanceId'),
    installationId: requiredString(body, 'installationId'),
    guildId: optionalString(body, 'guildId'),
    channelId: optionalString(body, 'channelId'),
    threadId: optionalString(body, 'threadId'),
    launchId: requiredString(body, 'launchId'),
    principalId: requiredString(body, 'principalId'),
    adapter: requiredString(body, 'adapter'),
    boundRunId: optionalString(body, 'boundRunId'),
  };
}

function sessionErrorReply(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof RouteValidationError)
    return reply.code(400).send({
      error: { code: error.message, message: error.message },
    });

  if (error instanceof ActivitySessionError) {
    const statusCode =
      error.message === 'instance_binding_mismatch'
        ? 409
        : error.message === 'instance_closed' ||
            error.message === 'instance_expired'
          ? 410
          : 500;
    if (statusCode === 500) request.log.error(error);
    return reply.code(statusCode).send({
      error: { code: error.message, message: error.message },
    });
  }

  request.log.error(error);
  return reply.code(500).send({
    error: { code: 'internal_error', message: 'Internal error' },
  });
}

export async function registerActivityRoutes(
  app: FastifyInstance,
  sessionService: ActivitySessionService,
): Promise<void> {
  const config = app.serviceAuthConfig;
  if (!config)
    throw new Error('Service auth config required for activity routes');

  app.post(
    '/api/v1/discord/activity/sessions',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authenticated = await requireServiceAuth(request, reply, config);
      if (!authenticated) return;

      try {
        const result = await sessionService.createOrJoinSession(
          parseCreateSessionRequest(request),
        );
        return reply.header('cache-control', 'no-store').code(201).send({
          instanceBindingId: result.instanceBindingId,
          sessionToken: result.session.sessionToken,
          expiresAt: result.session.expiresAt.toISOString(),
          idleExpiresAt: result.session.idleExpiresAt.toISOString(),
        });
      } catch (error: unknown) {
        return sessionErrorReply(error, request, reply);
      }
    },
  );

  app.post(
    '/api/v1/discord/activity/sessions/refresh',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authenticated = await requireServiceAuth(request, reply, config);
      if (!authenticated) return;

      try {
        const sessionToken = requiredString(
          bodyRecord(request),
          'sessionToken',
        );
        const result = await sessionService.refreshSession(sessionToken);
        if (!result)
          return reply.code(404).send({
            error: {
              code: 'session_not_found',
              message: 'Session not found or expired',
            },
          });

        return reply.header('cache-control', 'no-store').send({
          sessionToken: result.sessionToken,
          expiresAt: result.expiresAt.toISOString(),
          idleExpiresAt: result.idleExpiresAt.toISOString(),
        });
      } catch (error: unknown) {
        return sessionErrorReply(error, request, reply);
      }
    },
  );

  app.post(
    '/api/v1/discord/activity/sessions/revoke',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authenticated = await requireServiceAuth(request, reply, config);
      if (!authenticated) return;

      try {
        const sessionToken = requiredString(
          bodyRecord(request),
          'sessionToken',
        );
        await sessionService.revokeSession(sessionToken);
        return reply.code(204).send();
      } catch (error: unknown) {
        return sessionErrorReply(error, request, reply);
      }
    },
  );
}
