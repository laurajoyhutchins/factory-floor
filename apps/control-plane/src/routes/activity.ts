import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ActivitySessionService } from '@factory-floor/runtime-core';
import {
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
  return result;
}

function optionalString(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const result = value[field];
  return typeof result === 'string' && result.trim() !== ''
    ? result
    : undefined;
}

async function requireServiceAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  config: ServiceAuthConfig,
): Promise<boolean> {
  try {
    await verifyServiceRequest(
      config,
      request.method,
      request.url.split('?', 1)[0] ?? request.url,
      request.body,
      request.headers['x-factory-floor-service-auth'] as string | undefined,
    );
    return true;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'message' in error && (error as Record<string, unknown>).name === 'ServiceAuthError') {
      const authErr = error as { statusCode?: number; message: string };
      await reply.code(authErr.statusCode ?? 401).send({
        error: { code: authErr.message, message: authErr.message },
      });
      return false;
    }
    await reply.code(401).send({
      error: { code: 'service_auth_denied', message: 'Service authentication denied' },
    });
    return false;
  }
}

function parseCreateSessionRequest(
  request: FastifyRequest,
): {
  applicationId: string;
  instanceId: string;
  installationId: string;
  guildId?: string;
  channelId?: string;
  threadId?: string;
  launchId: string;
  principalId: string;
  adapter: string;
  boundRunId?: string;
} {
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
      const authed = await requireServiceAuth(request, reply, config);
      if (!authed) return;

      try {
        const sessionRequest = parseCreateSessionRequest(request);
        const result = await sessionService.createOrJoinSession(sessionRequest);
        return reply.code(201).send({
          instanceBindingId: result.instanceBindingId,
          sessionToken: result.session.sessionId,
          expiresAt: result.session.expiresAt.toISOString(),
          idleExpiresAt: result.session.idleExpiresAt.toISOString(),
        });
      } catch (error: unknown) {
        if (error instanceof RouteValidationError) {
          return reply.code(400).send({
            error: { code: error.message, message: error.message },
          });
        }
        request.log.error(error);
        return reply.code(500).send({
          error: { code: 'internal_error', message: 'Internal error' },
        });
      }
    },
  );

  app.post(
    '/api/v1/discord/activity/sessions/refresh',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authed = await requireServiceAuth(request, reply, config);
      if (!authed) return;

      try {
        const body = bodyRecord(request);
        const sessionToken = requiredString(body, 'sessionToken');
        const result = await sessionService.refreshSession(sessionToken);
        if (!result) {
          return reply.code(404).send({
            error: {
              code: 'session_not_found',
              message: 'Session not found or expired',
            },
          });
        }
        return reply.send({
          sessionToken: result.sessionId,
          expiresAt: result.expiresAt.toISOString(),
          idleExpiresAt: result.idleExpiresAt.toISOString(),
        });
      } catch (error: unknown) {
        if (error instanceof RouteValidationError) {
          return reply.code(400).send({
            error: { code: error.message, message: error.message },
          });
        }
        request.log.error(error);
        return reply.code(500).send({
          error: { code: 'internal_error', message: 'Internal error' },
        });
      }
    },
  );

  app.post(
    '/api/v1/discord/activity/sessions/revoke',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authed = await requireServiceAuth(request, reply, config);
      if (!authed) return;

      try {
        const body = bodyRecord(request);
        const sessionToken = requiredString(body, 'sessionToken');
        await sessionService.revokeSession(sessionToken);
        return reply.code(204).send();
      } catch (error: unknown) {
        if (error instanceof RouteValidationError) {
          return reply.code(400).send({
            error: { code: error.message, message: error.message },
          });
        }
        request.log.error(error);
        return reply.code(500).send({
          error: { code: 'internal_error', message: 'Internal error' },
        });
      }
    },
  );
}
