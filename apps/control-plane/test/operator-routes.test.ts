import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  OperatorConflictError,
  OperatorNotFoundError,
} from '@factory-floor/runtime-core';
import { registerOperatorRoutes } from '../src/routes/operator.js';
import { registerControlPlaneSecurity } from '../src/security.js';

function services() {
  return {
    commands: {
      submitDevelopmentTask: vi.fn(async () => ({
        runId: 'run-1',
        commandId: 'run-1',
        regionId: 'region-1',
        regionName: 'investigation',
        status: 'accepted',
        disposition: 'accepted',
        rejection: null,
      })),
      decideApproval: vi.fn(async () => ({
        approvalId: 'approval-1',
        decision: 'approve',
        status: 'recorded',
        principalId: 'discord:user-1',
        reason: 'Approved in Discord.',
        clientRequestId: 'decision-1',
        disposition: 'accepted',
      })),
      cancelRun: vi.fn(async () => ({
        runId: 'run-1',
        cancellationCommandId: 'cancel-1',
        clientRequestId: 'cancel-request-1',
        disposition: 'accepted',
        cancelledDeliveries: 1,
        cancelledExecutions: 1,
        cancelledAttempts: 1,
      })),
    },
    queries: {
      getFactoryStatus: vi.fn(async () => ({ status: 'healthy' })),
      getRunStatus: vi.fn(async () => ({ runId: 'run-1', status: 'running' })),
      inspectRunTrace: vi.fn(async () => ({ run: { id: 'run-1' } })),
      listRunArtifacts: vi.fn(async () => ({ items: [], nextCursor: null })),
      readArtifact: vi.fn(async () => ({ artifactId: 'artifact-1' })),
      listPendingApprovals: vi.fn(async () => ({
        items: [],
        nextCursor: null,
      })),
    },
  };
}

async function app() {
  const instance = Fastify();
  registerControlPlaneSecurity(instance, {
    operatorToken: 'operator-secret',
    adminToken: 'admin-secret',
  });
  const injected = services();
  await registerOperatorRoutes(
    instance,
    injected.commands as never,
    injected.queries as never,
  );
  return { instance, ...injected };
}

const headers = {
  authorization: 'Bearer operator-secret',
  'x-factory-floor-principal-id': 'discord:user-1',
  'x-factory-floor-adapter': 'discord-agent',
};

describe('operator routes', () => {
  it('submits attributed development tasks through the operator service', async () => {
    const context = await app();
    const response = await context.instance.inject({
      method: 'POST',
      url: '/api/v1/operator/tasks',
      headers,
      payload: {
        clientRequestId: 'discord-message-1',
        repository: 'laurajoyhutchins/factory-floor',
        objective: 'Implement the Discord bridge.',
        acceptanceCriteria: ['The run is visible in its Discord thread.'],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ runId: 'run-1' });
    expect(context.commands.submitDevelopmentTask).toHaveBeenCalledWith(
      {
        principal: { id: 'discord:user-1', roles: ['operator'] },
        adapter: 'discord-agent',
      },
      expect.objectContaining({ clientRequestId: 'discord-message-1' }),
    );

    await context.instance.close();
  });

  it('requires both durable attribution headers', async () => {
    const context = await app();
    const missingPrincipal = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/status',
      headers: {
        authorization: 'Bearer operator-secret',
        'x-factory-floor-adapter': 'discord-agent',
      },
    });
    expect(missingPrincipal.statusCode).toBe(400);
    expect(missingPrincipal.json()).toMatchObject({
      error: { code: 'operator_principal_required' },
    });

    const missingAdapter = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/status',
      headers: {
        authorization: 'Bearer operator-secret',
        'x-factory-floor-principal-id': 'discord:user-1',
      },
    });
    expect(missingAdapter.statusCode).toBe(400);
    expect(missingAdapter.json()).toMatchObject({
      error: { code: 'operator_adapter_required' },
    });

    await context.instance.close();
  });

  it('forwards bounded query parameters', async () => {
    const context = await app();
    const artifacts = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/runs/run-1/artifacts?limit=10&cursor=next',
      headers,
    });
    expect(artifacts.statusCode).toBe(200);
    expect(context.queries.listRunArtifacts).toHaveBeenCalledWith(
      expect.any(Object),
      'run-1',
      { limit: 10, cursor: 'next' },
    );

    const artifact = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/artifacts/artifact-1?maxBytes=4096',
      headers,
    });
    expect(artifact.statusCode).toBe(200);
    expect(context.queries.readArtifact).toHaveBeenCalledWith(
      expect.any(Object),
      'artifact-1',
      4096,
    );

    await context.instance.close();
  });

  it('rejects malformed task payloads before invoking the service', async () => {
    const context = await app();
    const wrongType = await context.instance.inject({
      method: 'POST',
      url: '/api/v1/operator/tasks',
      headers,
      payload: {
        clientRequestId: 123,
        repository: 'laurajoyhutchins/factory-floor',
        objective: 'Implement the Discord bridge.',
        acceptanceCriteria: ['Relevant tests pass.'],
      },
    });
    const unknownField = await context.instance.inject({
      method: 'POST',
      url: '/api/v1/operator/tasks',
      headers,
      payload: {
        clientRequestId: 'request-1',
        repository: 'laurajoyhutchins/factory-floor',
        objective: 'Implement the Discord bridge.',
        acceptanceCriteria: ['Relevant tests pass.'],
        typoAuthority: true,
      },
    });

    for (const response of [wrongType, unknownField]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'malformed_operator_request' },
      });
    }
    expect(context.commands.submitDevelopmentTask).not.toHaveBeenCalled();

    await context.instance.close();
  });

  it('rejects malformed approval and cancellation payloads', async () => {
    const context = await app();
    const approval = await context.instance.inject({
      method: 'POST',
      url: '/api/v1/operator/approvals/approval-1/decision',
      headers,
      payload: {
        clientRequestId: 'decision-1',
        decision: 1,
        reason: 'Approved in Discord.',
      },
    });
    const cancellation = await context.instance.inject({
      method: 'POST',
      url: '/api/v1/operator/runs/run-1/cancel',
      headers,
      payload: {
        clientRequestId: 'cancel-1',
        reason: { text: 'Cancel it.' },
      },
    });

    for (const response of [approval, cancellation]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'malformed_operator_request' },
      });
    }
    expect(context.commands.decideApproval).not.toHaveBeenCalled();
    expect(context.commands.cancelRun).not.toHaveBeenCalled();

    await context.instance.close();
  });

  it('maps durable conflicts and missing records without leaking internals', async () => {
    const context = await app();
    context.commands.decideApproval.mockRejectedValueOnce(
      new OperatorConflictError('approval_not_pending'),
    );
    context.queries.getRunStatus.mockRejectedValueOnce(
      new OperatorNotFoundError('run_not_found'),
    );

    const conflict = await context.instance.inject({
      method: 'POST',
      url: '/api/v1/operator/approvals/approval-1/decision',
      headers,
      payload: {
        clientRequestId: 'decision-1',
        decision: 'approve',
        reason: 'Approved in Discord.',
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'approval_not_pending' },
    });

    const missing = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/runs/missing',
      headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'run_not_found' } });

    await context.instance.close();
  });
});
