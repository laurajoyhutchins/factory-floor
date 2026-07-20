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
      cancelRun: vi.fn(),
    },
    queries: {
      getFactoryStatus: vi.fn(async () => ({ status: 'healthy' })),
      getRunStatus: vi.fn(async () => ({ runId: 'run-1' })),
      inspectRunTrace: vi.fn(async () => ({ run: { id: 'run-1' } })),
      listRunTemplateInstantiations: vi.fn(async () => ({
        items: [],
        nextCursor: null,
      })),
      listRunArtifacts: vi.fn(async () => ({ items: [], nextCursor: null })),
      readArtifact: vi.fn(async () => ({ artifactId: 'artifact-1' })),
      listPendingApprovals: vi.fn(async () => ({
        items: [],
        nextCursor: null,
      })),
      getRunTopology: vi.fn(async () => ({
        run: { id: 'run-1' },
        regions: [],
        topologyRevisions: [],
        components: [],
        connections: [],
        deliveries: [],
        executions: [],
        relationships: [],
      })),
      listRunAlerts: vi.fn(async () => ({ items: [], nextCursor: null })),
      listRunEvents: vi.fn(async () => ({
        items: [],
        nextCursor: null,
        complete: true,
      })),
      readRunArtifact: vi.fn(async () => ({ artifactId: 'artifact-1' })),
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

describe('run-scoped operator routes', () => {
  it('forwards bounded topology, alert, and finite-event requests with attribution', async () => {
    const context = await app();

    const topology = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/runs/run-1/topology?regionLimit=2&componentLimit=3&connectionLimit=4',
      headers,
    });
    expect(topology.statusCode).toBe(200);
    expect(context.queries.getRunTopology).toHaveBeenCalledWith(
      {
        principal: { id: 'operator:user-1', roles: ['operator'] },
        adapter: 'standalone-console',
      },
      'run-1',
      { regionLimit: 2, componentLimit: 3, connectionLimit: 4 },
    );

    const alerts = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/runs/run-1/alerts?limit=10&cursor=alert-cursor',
      headers,
    });
    expect(alerts.statusCode).toBe(200);
    expect(context.queries.listRunAlerts).toHaveBeenCalledWith(
      expect.any(Object),
      'run-1',
      { limit: 10, cursor: 'alert-cursor' },
    );

    const events = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/runs/run-1/events?limit=25&cursor=event-cursor',
      headers,
    });
    expect(events.statusCode).toBe(200);
    expect(context.queries.listRunEvents).toHaveBeenCalledWith(
      expect.any(Object),
      'run-1',
      { limit: 25, cursor: 'event-cursor' },
    );

    await context.instance.close();
  });

  it('requires the run identity when reading an artifact', async () => {
    const context = await app();
    const scoped = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/runs/run-1/artifacts/artifact-1?maxBytes=4096',
      headers,
    });
    expect(scoped.statusCode).toBe(200);
    expect(context.queries.readRunArtifact).toHaveBeenCalledWith(
      expect.any(Object),
      'run-1',
      'artifact-1',
      4096,
    );

    const unscoped = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/artifacts/artifact-1',
      headers,
    });
    expect(unscoped.statusCode).toBe(404);
    expect(context.queries.readArtifact).not.toHaveBeenCalled();

    await context.instance.close();
  });

  it('maps recoverable cursor failures to stable operator errors', async () => {
    const context = await app();
    context.queries.listRunEvents.mockRejectedValueOnce(
      new OperatorValidationError('cursor_expired'),
    );

    const response = await context.instance.inject({
      method: 'GET',
      url: '/api/v1/operator/runs/run-1/events?cursor=expired',
      headers,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'cursor_expired', message: 'cursor_expired' },
    });

    await context.instance.close();
  });
});
