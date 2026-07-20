import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ActivitySessionService } from '../activity-session-service.js';
import type { ActivitySessionAuthorizer } from '../activity-session-read-authorizer.js';

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  return /^Bearer ([^\s]+)$/.exec(header)?.[1];
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply
    .header('cache-control', 'no-store')
    .header('pragma', 'no-cache')
    .header('x-content-type-options', 'nosniff');
}

function unauthorized(reply: FastifyReply) {
  return noStore(reply).code(401).send({
    error: {
      code: 'activity_session_invalid',
      message: 'Activity session is missing, expired, revoked, or invalid.',
    },
  });
}

export async function registerActivityBrowserRoutes(
  app: FastifyInstance,
  sessionService: ActivitySessionService,
  authorizer: ActivitySessionAuthorizer,
): Promise<void> {
  app.get(
    '/api/v1/discord/activity/session',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = bearer(request);
      const session = token ? await authorizer.resolveSession(token) : null;
      if (!session) return unauthorized(reply);
      if (!session.boundRunId)
        return noStore(reply).code(409).send({
          error: {
            code: 'activity_run_binding_required',
            message: 'Activity session is not bound to a run.',
          },
        });
      return noStore(reply).send({
        instanceBindingId: session.instanceBindingId,
        applicationId: session.applicationId,
        instanceId: session.instanceId,
        installationId: session.installationId,
        guildId: session.guildId,
        channelId: session.channelId,
        threadId: session.threadId,
        principalId: session.principalId,
        adapter: session.adapter,
        runId: session.boundRunId,
        expiresAt: session.expiresAt.toISOString(),
        idleExpiresAt: session.idleExpiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/api/v1/discord/activity/session/refresh',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = bearer(request);
      if (!token) return unauthorized(reply);
      const replacement = await sessionService.refreshSession(token);
      if (!replacement) return unauthorized(reply);
      return noStore(reply).send({
        sessionToken: replacement.sessionToken,
        expiresAt: replacement.expiresAt.toISOString(),
        idleExpiresAt: replacement.idleExpiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/api/v1/discord/activity/session/revoke',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = bearer(request);
      if (!token) return unauthorized(reply);
      await sessionService.revokeSession(token);
      return noStore(reply).code(204).send();
    },
  );
}
