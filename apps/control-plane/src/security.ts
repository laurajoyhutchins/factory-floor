import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

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

function securityError(code: 'authentication_required' | 'forbidden') {
  return {
    error: {
      code,
      message:
        code === 'authentication_required'
          ? 'A control-plane bearer token is required.'
          : 'The supplied bearer token is not authorized for this operation.',
    },
  };
}

export function registerControlPlaneSecurity(
  app: FastifyInstance,
  security: ControlPlaneSecurity,
): void {
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0] ?? request.url;
    if (path === '/health' || path.startsWith('/worker/v1/')) return;
    if (!path.startsWith('/api/v1/')) return;

    const supplied = bearer(request);
    if (!supplied)
      return reply.code(401).send(securityError('authentication_required'));

    const inspectionRead =
      (request.method === 'GET' || request.method === 'HEAD') &&
      path.startsWith('/api/v1/inspect/');
    const authorized = inspectionRead
      ? tokenMatches(supplied, security.operatorToken) ||
        tokenMatches(supplied, security.adminToken)
      : tokenMatches(supplied, security.adminToken);
    if (!authorized) return reply.code(403).send(securityError('forbidden'));
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
