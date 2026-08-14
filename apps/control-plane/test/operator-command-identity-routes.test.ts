import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerOperatorRoutes } from '../src/routes/operator.js';
import { registerControlPlaneSecurity } from '../src/security.js';

const headers = {
  authorization: 'Bearer operator-secret',
  'x-factory-floor-principal-id': 'discord:user-1',
  'x-factory-floor-adapter': 'discord-agent',
};

async function app() {
  const instance = Fastify();
  registerControlPlaneSecurity(instance, {
    operatorToken: 'operator-secret',
    adminToken: 'admin-secret',
  });
  const commands = {
    submitDevelopmentTask: vi.fn(async () => ({
      commandId: 'cmd-1',
      regionId: 'region-1',
      regionName: 'investigation',
      status: 'accepted',
      disposition: 'accepted',
      rejection: null,
    })),
    decideApproval: vi.fn(),
    cancelCommand: vi.fn(async () => ({
      commandId: 'cmd-1',
      cancellationCommandId: 'cancel-1',
      clientRequestId: 'cancel-request-1',
      disposition: 'accepted',
      cancelledDeliveries: 1,
      cancelledExecutions: 1,
      cancelledAttempts: 1,
    })),
  };
  const queries = {
    getFactoryStatus: vi.fn(async () => ({ status: 'healthy' })),
    getCommandStatus: vi.fn(async () => ({
      commandId: 'cmd-1',
      status: 'running',
    })),
    inspectCommandTrace: vi.fn(async () => ({ command: { id: 'cmd-1' } })),
    getCommandTopology: vi.fn(async () => ({ command: { id: 'cmd-1' } })),
    listCommandAlerts: vi.fn(async () => ({ items: [], nextCursor: null })),
    listCommandEvents: vi.fn(async () => ({
      items: [],
      nextCursor: null,
      resumeCursor: null,
      complete: true,
    })),
    listCommandTemplateInstantiations: vi.fn(async () => ({
      items: [],
      nextCursor: null,
    })),
    listCommandArtifacts: vi.fn(async () => ({ items: [], nextCursor: null })),
    readCommandArtifact: vi.fn(async () => ({ artifactId: 'artifact-1' })),
    listPendingApprovals: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
  await registerOperatorRoutes(instance, commands as never, queries as never);
  return { instance, commands, queries };
}

describe('durable operator command identity', () => {
  it('returns commandId without a synthetic runId alias', async () => {
    const context = await app();
    const response = await context.instance.inject({
      method: 'POST',
      url: '/api/v1/operator/tasks',
      headers,
      payload: {
        clientRequestId: 'discord-message-1',
        repository: 'laurajoyhutchins/factory-floor',
        objective: 'Normalize operator identity.',
        acceptanceCriteria: ['The command is the durable operator root.'],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ commandId: 'cmd-1' });
    expect(response.json()).not.toHaveProperty('runId');
    await context.instance.close();
  });

  it('uses command-named read and cancellation routes', async () => {
    const context = await app();

    const status = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/commands/cmd-1',
      headers,
    });
    expect(status.statusCode).toBe(200);
    expect(context.queries.getCommandStatus).toHaveBeenCalledWith(
      expect.any(Object),
      'cmd-1',
    );

    const artifacts = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/commands/cmd-1/artifacts?limit=10&cursor=next',
      headers,
    });
    expect(artifacts.statusCode).toBe(200);
    expect(context.queries.listCommandArtifacts).toHaveBeenCalledWith(
      expect.any(Object),
      'cmd-1',
      { limit: 10, cursor: 'next' },
    );

    const cancellation = await context.instance.inject({
      method: 'POST',
      url: '/api/v1/operator/commands/cmd-1/cancel',
      headers,
      payload: {
        clientRequestId: 'cancel-request-1',
        reason: 'Owner cancelled the command.',
      },
    });
    expect(cancellation.statusCode).toBe(202);
    expect(context.commands.cancelCommand).toHaveBeenCalledWith(
      'cmd-1',
      expect.objectContaining({ clientRequestId: 'cancel-request-1' }),
      expect.any(Object),
    );

    await context.instance.close();
  });

  it('does not expose legacy run identity routes', async () => {
    const context = await app();
    const response = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/runs/cmd-1',
      headers,
    });
    expect(response.statusCode).toBe(404);
    await context.instance.close();
  });
});
