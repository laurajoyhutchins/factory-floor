import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerOperatorRoutes } from '../src/routes/operator.js';
import { registerControlPlaneSecurity } from '../src/security.js';

const headers = {
  authorization: 'Bearer operator-secret',
  'x-factory-floor-principal-id': 'standalone-console',
  'x-factory-floor-adapter': 'standalone-console',
};

describe('operator cancellable-run route', () => {
  it('returns only the authoritative cancellable-run page from the operator query service', async () => {
    const instance = Fastify();
    registerControlPlaneSecurity(instance, {
      operatorToken: 'operator-secret',
      adminToken: 'admin-secret',
    });
    const commands = {
      submitDevelopmentTask: vi.fn(),
      decideApproval: vi.fn(),
      cancelRun: vi.fn(),
    };
    const queries = {
      getFactoryStatus: vi.fn(),
      getRunStatus: vi.fn(),
      getRunDetails: vi.fn(),
      inspectRunTrace: vi.fn(),
      getRunTopology: vi.fn(),
      listRunAlerts: vi.fn(),
      listRunEvents: vi.fn(),
      listRunTemplateInstantiations: vi.fn(),
      listRunArtifacts: vi.fn(),
      readRunArtifact: vi.fn(),
      listPendingApprovals: vi.fn(),
      listCancellableRuns: vi.fn(async () => ({
        items: [
          {
            runId: 'run-cancellable',
            commandType: 'development.task',
            regionId: 'region-1',
            regionName: 'repository-task',
          },
        ],
        nextCursor: 'next-run',
      })),
    };
    await registerOperatorRoutes(
      instance,
      commands as never,
      queries as never,
    );

    const response = await instance.inject({
      method: 'GET',
      url: '/api/v1/operator/cancellable-runs?limit=10&cursor=previous-run',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          runId: 'run-cancellable',
          commandType: 'development.task',
          regionId: 'region-1',
          regionName: 'repository-task',
        },
      ],
      nextCursor: 'next-run',
    });
    expect(queries.listCancellableRuns).toHaveBeenCalledWith(
      {
        principal: { id: 'standalone-console', roles: ['operator'] },
        adapter: 'standalone-console',
      },
      { limit: 10, cursor: 'previous-run' },
    );

    await instance.close();
  });
});
