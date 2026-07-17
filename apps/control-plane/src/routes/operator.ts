import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  OperatorAuthorizationError,
  OperatorConflictError,
  OperatorNotFoundError,
  OperatorValidationError,
  type ApprovalDecisionRequest,
  type DevelopmentTaskRequest,
  type OperatorCommandService,
  type OperatorContext,
  type OperatorQueryService,
  type PageRequest,
  type RunCancellationRequest,
} from '@factory-floor/runtime-core';

type OperatorCommands = Pick<
  OperatorCommandService,
  'submitDevelopmentTask' | 'decideApproval' | 'cancelRun'
>;

type OperatorQueries = Pick<
  OperatorQueryService,
  | 'getFactoryStatus'
  | 'getRunStatus'
  | 'inspectRunTrace'
  | 'listRunArtifacts'
  | 'readArtifact'
  | 'listPendingApprovals'
>;

const PRINCIPAL_HEADER = 'x-factory-floor-principal-id';
const ADAPTER_HEADER = 'x-factory-floor-adapter';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function operatorContext(request: FastifyRequest): OperatorContext {
  const principalId = headerValue(request.headers[PRINCIPAL_HEADER])?.trim();
  if (!principalId || principalId.length > 200)
    throw new OperatorValidationError('operator_principal_required');
  const adapter = headerValue(request.headers[ADAPTER_HEADER])?.trim();
  if (adapter && adapter.length > 100)
    throw new OperatorValidationError('operator_adapter_too_long');
  return {
    principal: { id: principalId, roles: ['operator'] },
    ...(adapter ? { adapter } : {}),
  };
}

function requiredParam(request: FastifyRequest, name: string): string {
  const params = isRecord(request.params) ? request.params : {};
  const value = params[name];
  if (typeof value !== 'string' || value.trim() === '')
    throw new OperatorValidationError(`${name}_required`);
  return value;
}

function pageRequest(request: FastifyRequest): PageRequest {
  const query = isRecord(request.query) ? request.query : {};
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined;
  const limit =
    typeof query.limit === 'string'
      ? Number(query.limit)
      : typeof query.limit === 'number'
        ? query.limit
        : undefined;
  return {
    ...(cursor ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function artifactByteLimit(request: FastifyRequest): number | undefined {
  const query = isRecord(request.query) ? request.query : {};
  if (query.maxBytes === undefined) return undefined;
  return typeof query.maxBytes === 'number'
    ? query.maxBytes
    : Number(query.maxBytes);
}

function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  if (!isRecord(request.body))
    throw new OperatorValidationError('malformed_operator_request');
  return request.body;
}

function errorStatus(error: unknown): number {
  if (error instanceof OperatorValidationError) return 400;
  if (error instanceof OperatorAuthorizationError) return 403;
  if (error instanceof OperatorNotFoundError) return 404;
  if (error instanceof OperatorConflictError) return 409;
  return 500;
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : 'internal_error';
}

async function handleOperatorError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  const status = errorStatus(error);
  if (status === 500) request.log.error(error);
  return reply.code(status).send({
    error: {
      code: status === 500 ? 'internal_error' : errorCode(error),
      message: status === 500 ? 'Internal error' : errorCode(error),
    },
  });
}

export async function registerOperatorRoutes(
  app: FastifyInstance,
  commands: OperatorCommands,
  queries: OperatorQueries,
): Promise<void> {
  app.get('/api/v1/operator/status', async (request, reply) => {
    try {
      return await queries.getFactoryStatus(operatorContext(request));
    } catch (error) {
      return handleOperatorError(request, reply, error);
    }
  });

  app.post('/api/v1/operator/tasks', async (request, reply) => {
    try {
      const result = await commands.submitDevelopmentTask(
        operatorContext(request),
        bodyRecord(request) as unknown as DevelopmentTaskRequest,
      );
      return reply
        .code(
          result.disposition === 'replayed'
            ? 200
            : result.disposition === 'rejected'
              ? 422
              : 202,
        )
        .send(result);
    } catch (error) {
      return handleOperatorError(request, reply, error);
    }
  });

  app.get('/api/v1/operator/runs/:runId', async (request, reply) => {
    try {
      return await queries.getRunStatus(
        operatorContext(request),
        requiredParam(request, 'runId'),
      );
    } catch (error) {
      return handleOperatorError(request, reply, error);
    }
  });

  app.get('/api/v1/operator/runs/:runId/trace', async (request, reply) => {
    try {
      return await queries.inspectRunTrace(
        operatorContext(request),
        requiredParam(request, 'runId'),
      );
    } catch (error) {
      return handleOperatorError(request, reply, error);
    }
  });

  app.get('/api/v1/operator/runs/:runId/artifacts', async (request, reply) => {
    try {
      return await queries.listRunArtifacts(
        operatorContext(request),
        requiredParam(request, 'runId'),
        pageRequest(request),
      );
    } catch (error) {
      return handleOperatorError(request, reply, error);
    }
  });

  app.get('/api/v1/operator/artifacts/:artifactId', async (request, reply) => {
    try {
      const maxBytes = artifactByteLimit(request);
      return await queries.readArtifact(
        operatorContext(request),
        requiredParam(request, 'artifactId'),
        maxBytes,
      );
    } catch (error) {
      return handleOperatorError(request, reply, error);
    }
  });

  app.get('/api/v1/operator/approvals', async (request, reply) => {
    try {
      return await queries.listPendingApprovals(
        operatorContext(request),
        pageRequest(request),
      );
    } catch (error) {
      return handleOperatorError(request, reply, error);
    }
  });

  app.post(
    '/api/v1/operator/approvals/:approvalId/decision',
    async (request, reply) => {
      try {
        return await commands.decideApproval(
          operatorContext(request),
          requiredParam(request, 'approvalId'),
          bodyRecord(request) as unknown as ApprovalDecisionRequest,
        );
      } catch (error) {
        return handleOperatorError(request, reply, error);
      }
    },
  );

  app.post('/api/v1/operator/runs/:runId/cancel', async (request, reply) => {
    try {
      const result = await commands.cancelRun(
        operatorContext(request),
        requiredParam(request, 'runId'),
        bodyRecord(request) as unknown as RunCancellationRequest,
      );
      return reply
        .code(result.disposition === 'replayed' ? 200 : 202)
        .send(result);
    } catch (error) {
      return handleOperatorError(request, reply, error);
    }
  });
}
