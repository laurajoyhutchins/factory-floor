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
const MALFORMED_REQUEST = 'malformed_operator_request';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requiredHeader(
  request: FastifyRequest,
  name: string,
  maximumLength: number,
  missingCode: string,
  tooLongCode: string,
): string {
  const value = headerValue(request.headers[name])?.trim();
  if (!value) throw new OperatorValidationError(missingCode);
  if (value.length > maximumLength)
    throw new OperatorValidationError(tooLongCode);
  return value;
}

function operatorContext(request: FastifyRequest): OperatorContext {
  const principalId = requiredHeader(
    request,
    PRINCIPAL_HEADER,
    200,
    'operator_principal_required',
    'operator_principal_too_long',
  );
  const adapter = requiredHeader(
    request,
    ADAPTER_HEADER,
    100,
    'operator_adapter_required',
    'operator_adapter_too_long',
  );
  return {
    principal: { id: principalId, roles: ['operator'] },
    adapter,
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
    throw new OperatorValidationError(MALFORMED_REQUEST);
  return request.body;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    throw new OperatorValidationError(MALFORMED_REQUEST);
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string')
    throw new OperatorValidationError(MALFORMED_REQUEST);
  return result;
}

function parseDevelopmentTaskRequest(
  request: FastifyRequest,
): DevelopmentTaskRequest {
  const body = bodyRecord(request);
  assertOnlyKeys(body, [
    'clientRequestId',
    'repository',
    'objective',
    'acceptanceCriteria',
    'authority',
    'metadata',
  ]);

  const acceptanceCriteria = body.acceptanceCriteria;
  if (
    !Array.isArray(acceptanceCriteria) ||
    acceptanceCriteria.some((item) => typeof item !== 'string')
  )
    throw new OperatorValidationError(MALFORMED_REQUEST);

  let authority: DevelopmentTaskRequest['authority'];
  if (body.authority !== undefined) {
    if (!isRecord(body.authority))
      throw new OperatorValidationError(MALFORMED_REQUEST);
    assertOnlyKeys(body.authority, [
      'mayCreateBranch',
      'mayOpenDraftPullRequest',
      'mayMerge',
    ]);
    for (const value of Object.values(body.authority))
      if (typeof value !== 'boolean')
        throw new OperatorValidationError(MALFORMED_REQUEST);
    authority = body.authority as NonNullable<
      DevelopmentTaskRequest['authority']
    >;
  }

  let metadata: DevelopmentTaskRequest['metadata'];
  if (body.metadata !== undefined) {
    if (!isRecord(body.metadata))
      throw new OperatorValidationError(MALFORMED_REQUEST);
    for (const value of Object.values(body.metadata))
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      )
        throw new OperatorValidationError(MALFORMED_REQUEST);
    metadata = body.metadata as NonNullable<DevelopmentTaskRequest['metadata']>;
  }

  return {
    clientRequestId: requiredString(body, 'clientRequestId'),
    repository: requiredString(body, 'repository'),
    objective: requiredString(body, 'objective'),
    acceptanceCriteria,
    ...(authority ? { authority } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function parseApprovalDecisionRequest(
  request: FastifyRequest,
): ApprovalDecisionRequest {
  const body = bodyRecord(request);
  assertOnlyKeys(body, ['clientRequestId', 'decision', 'reason']);
  return {
    clientRequestId: requiredString(body, 'clientRequestId'),
    decision: requiredString(
      body,
      'decision',
    ) as ApprovalDecisionRequest['decision'],
    reason: requiredString(body, 'reason'),
  };
}

function parseRunCancellationRequest(
  request: FastifyRequest,
): RunCancellationRequest {
  const body = bodyRecord(request);
  assertOnlyKeys(body, ['clientRequestId', 'reason']);
  return {
    clientRequestId: requiredString(body, 'clientRequestId'),
    reason: requiredString(body, 'reason'),
  };
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
        parseDevelopmentTaskRequest(request),
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
      return await queries.readArtifact(
        operatorContext(request),
        requiredParam(request, 'artifactId'),
        artifactByteLimit(request),
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
          parseApprovalDecisionRequest(request),
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
        parseRunCancellationRequest(request),
      );
      return reply
        .code(result.disposition === 'replayed' ? 200 : 202)
        .send(result);
    } catch (error) {
      return handleOperatorError(request, reply, error);
    }
  });
}
