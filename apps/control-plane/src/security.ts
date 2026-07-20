import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActivitySessionAuthorizer } from './activity-session-read-authorizer.js';

export interface ControlPlaneSecurity {
  operatorToken: string;
  adminToken: string;
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  return /^Bearer ([^\s]+)$/.exec(header)?.[1];
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function securityError(
  code:
    'authentication_required' | 'forbidden' | 'activity_run_binding_mismatch',
) {
  const message =
    code === 'authentication_required'
      ? 'A control-plane bearer token is required.'
      : code === 'activity_run_binding_mismatch'
        ? 'The Activity session is not authorized for this run.'
        : 'The supplied bearer token is not authorized for this operation.';
  return { error: { code, message } };
}

function isServiceAuthenticatedActivityRoute(path: string): boolean {
  return (
    path === '/api/v1/discord/activity/sessions' ||
    path === '/api/v1/discord/activity/sessions/refresh' ||
    path === '/api/v1/discord/activity/sessions/revoke'
  );
}

function isBrowserActivitySessionRoute(path: string): boolean {
  return (
    path === '/api/v1/discord/activity/session' ||
    path === '/api/v1/discord/activity/session/refresh' ||
    path === '/api/v1/discord/activity/session/revoke'
  );
}

function activityRunId(path: string): string | undefined {
  const encoded = /^\/api\/v1\/operator\/runs\/([^/]+)(?:\/|$)/.exec(path)?.[1];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export function registerControlPlaneSecurity(
  app: FastifyInstance,
  security: ControlPlaneSecurity,
  activitySessions?: ActivitySessionAuthorizer,
): void {
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0] ?? request.url;
    if (
      path === '/health' ||
      path.startsWith('/health/') ||
      path.startsWith('/worker/v1/') ||
      isServiceAuthenticatedActivityRoute(path) ||
      isBrowserActivitySessionRoute(path)
    )
      return;
    if (!path.startsWith('/api/v1/')) return;

    const supplied = bearer(request);
    if (!supplied)
      return reply.code(401).send(securityError('authentication_required'));

    const inspectionRead =
      (request.method === 'GET' || request.method === 'HEAD') &&
      path.startsWith('/api/v1/inspect/');
    const operatorOperation = path.startsWith('/api/v1/operator/');
    const staticallyAuthorized =
      inspectionRead || operatorOperation
        ? tokenMatches(supplied, security.operatorToken) ||
          tokenMatches(supplied, security.adminToken)
        : tokenMatches(supplied, security.adminToken);
    if (staticallyAuthorized) return;

    const runId = activityRunId(path);
    const activityRead =
      activitySessions &&
      runId &&
      (request.method === 'GET' || request.method === 'HEAD');
    if (activityRead) {
      const session = await activitySessions.resolveSession(supplied);
      if (!session) return reply.code(403).send(securityError('forbidden'));
      if (!session.boundRunId || session.boundRunId !== runId)
        return reply
          .code(403)
          .send(securityError('activity_run_binding_mismatch'));

      request.headers['x-factory-floor-principal-id'] = session.principalId;
      request.headers['x-factory-floor-adapter'] = session.adapter;
      reply
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .header('x-content-type-options', 'nosniff');
      return;
    }

    return reply.code(403).send(securityError('forbidden'));
  });
}

export function controlPlaneSecurityFromEnv(
  env: Record<string, string | undefined>,
): ControlPlaneSecurity {
  const operatorToken = env.CONTROL_PLANE_OPERATOR_TOKEN?.trim();
  const adminToken = env.CONTROL_PLANE_ADMIN_TOKEN?.trim();
  if (!operatorToken)
    throw new Error('CONTROL_PLANE_OPERATOR_TOKEN is required');
  if (!adminToken) throw new Error('CONTROL_PLANE_ADMIN_TOKEN is required');
  if (operatorToken === adminToken)
    throw new Error('operator and admin tokens must be different');
  return { operatorToken, adminToken };
}
