import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { OperatorValidationError } from '@factory-floor/runtime-core';
import { registerOperatorRoutes } from '../src/routes/operator.js';
import { registerControlPlaneSecurity } from '../src/security.js';

const headers = {
  authorization: 'Bearer operator-secret',
  'x-factory-floor-principal-id': 'operator:user-1',
  'x-factory-floor-adapter': 'standalone-console',
};

function services() {
  return {
    commands: {
      submitDevelopmentTask: vi.fn(),
      decideApproval: vi.fn(),
      cancelCommand: vi.fn(),
    },
    queries: {
      getFactoryStatus: vi.fn(async () => ({ status: 'healthy' })),
      getCommandStatus: vi.fn(async () => ({ commandId: 'command-1' })),
      getCommandDetails: vi.fn(async () => ({ commandId: 'command-1' })),
      inspectCommandTrace: vi.fn(async () => ({
        command: { id: 'command-1' },
      })),
      listCommandTemplateInstantiations: vi.fn(async () => ({
        items: [],
        nextCursor: null,
      })),
      listCommandArtifacts: vi.fn(async () => ({ items: [], nextCursor: null })),
      listPendingApprovals: vi.fn(async () => ({
        items: [],
        nextCursor: null,
      })),
      getCommandTopology: vi.fn(async () => ({
        command: { id: 'command-1' },
        regions: [],
        topologyRevisions: [],
        components: [],
        connections: [],
        deliveries: [],
        executions: [],
        relationships: [],
      })),
      listCommandAlerts: vi.fn(async () => ({ items: [], nextCursor: null })),
      listCommandEvents: vi.fn(async () => ({
        items: [],
        nextCursor: null,
        resumeCursor: null,
        complete: true,
      })),
      readCommandArtifact: vi.fn(async () => ({ artifactId: 'artifact-1' })),
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

describe('command-scoped operator routes', () => {
  it('forwards bounded topology, alert, and finite-event requests with attribution', async () => {
    const context = await app();

    const topology = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/commands/command-1/topology?regionLimit=2&componentLimit=3&connectionLimit=4',
      headers,
    });
    expect(topology.statusCode).toBe(200);
    expect(context.queries.getCommandTopology).toHaveBeenCalledWith(
      {
        principal: { id: 'operator:user-1', roles: ['operator'] },
        adapter: 'standalone-console',
      },
      'command-1',
      { regionLimit: 2, componentLimit: 3, connectionLimit: 4 },
    );

    const alerts = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/commands/command-1/alerts?limit=10&cursor=alert-cursor',
      headers,
    });
    expect(alerts.statusCode).toBe(200);
    expect(context.queries.listCommandAlerts).toHaveBeenCalledWith(
      expect.any(Object),
      'command-1',
      { limit: 10, cursor: 'alert-cursor' },
    );

    const events = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/commands/command-1/events?limit=25&cursor=event-cursor',
      headers,
    });
    expect(events.statusCode).toBe(200);
    expect(context.queries.listCommandEvents).toHaveBeenCalledWith(
      expect.any(Object),
      'command-1',
      { limit: 25, cursor: 'event-cursor' },
    );

    await context.instance.close();
  });

  it('requires the command identity when reading an artifact', async () => {
    const context = await app();
    const scoped = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/commands/command-1/artifacts/artifact-1?maxBytes=4096',
      headers,
    });
    expect(scoped.statusCode).toBe(200);
    expect(context.queries.readCommandArtifact).toHaveBeenCalledWith(
      expect.any(Object),
      'command-1',
      'artifact-1',
      4096,
    );

    const unscoped = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/artifacts/artifact-1',
      headers,
    });
    expect(unscoped.statusCode).toBe(404);

    await context.instance.close();
  });

  it('maps recoverable cursor failures to stable operator errors', async () => {
    const context = await app();
    context.queries.listCommandEvents.mockRejectedValueOnce(
      new OperatorValidationError('cursor_expired'),
    );

    const response = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/commands/command-1/events?cursor=expired',
      headers,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'cursor_expired', message: 'cursor_expired' },
    });

    await context.instance.close();
  });
});
