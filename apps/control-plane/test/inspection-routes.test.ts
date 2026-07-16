import { encodeInspectionCursor } from '@factory-floor/runtime-core';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';

function service() {
  return {
    listRegions: vi.fn(async () => ({
      items: [{ id: 'r1', lifecycle_status: 'ready' }],
      nextCursor: null,
    })),
    listEvents: vi.fn(async () => ({
      items: [{ id: 'e1', event_type: 'x' }],
      nextCursor: 'cursor',
    })),
    listDeliveries: vi.fn(async () => ({ items: [], nextCursor: null })),
    listExecutions: vi.fn(async () => ({ items: [], nextCursor: null })),
    listAttempts: vi.fn(async () => ({ items: [], nextCursor: null })),
    listArtifacts: vi.fn(async () => ({ items: [], nextCursor: null })),
    listResources: vi.fn(async () => ({
      items: [
        {
          id: 'res1',
          attempt_id: 'attempt1',
          resource_type: 'cpuMilliseconds',
        },
      ],
      nextCursor: null,
    })),
    listPolicyDecisions: vi.fn(async () => ({
      items: [{ id: 'pol1', policy_name: 'm1.acceptance.operator-inspection' }],
      nextCursor: null,
    })),
    artifactLineage: vi.fn(async () => ({
      artifact: { id: 'a1' },
      derivations: [],
    })),
    executionTrace: vi.fn(async () => ({
      execution: { id: 'x1' },
      causalChain: { attempts: [] },
    })),
    projectionStatus: vi.fn(async () => [
      { projectionName: 'region-status', lastSequenceNumber: '1' },
    ]),
    rebuildProjections: vi.fn(async () => ({
      status: 'completed',
      checkpointed: 10,
    })),
  };
}

describe('inspection routes', () => {
  it('exposes bounded region and projection inspection endpoints', async () => {
    const obs = service();
    const app = await buildApp({ observabilityService: obs as never });
    const regions = await app.inject('/api/v1/inspect/regions?limit=1');
    expect(regions.statusCode).toBe(200);
    expect(regions.json().items[0].id).toBe('r1');
    expect(obs.listRegions).toHaveBeenCalledWith({
      cursor: undefined,
      limit: 1,
    });

    const resources = await app.inject('/api/v1/inspect/resources?limit=2');
    expect(resources.statusCode).toBe(200);
    expect(resources.json().items[0].attempt_id).toBe('attempt1');
    expect(obs.listResources).toHaveBeenCalledWith({
      cursor: undefined,
      limit: 2,
    });

    const policies = await app.inject('/api/v1/inspect/policy-decisions');
    expect(policies.statusCode).toBe(200);
    expect(policies.json().items[0].policy_name).toBe(
      'm1.acceptance.operator-inspection',
    );

    const projections = await app.inject('/api/v1/inspect/projections');
    expect(projections.statusCode).toBe(200);
    expect(projections.json().items[0].projectionName).toBe('region-status');
  });

  it('streams opaque resumable SSE cursors and checkpoints', async () => {
    const obs = service();
    const app = await buildApp({ observabilityService: obs as never });
    const previousCursor = encodeInspectionCursor('e0');
    const response = await app.inject({
      url: '/api/v1/inspect/stream?limit=1',
      headers: { 'last-event-id': previousCursor },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain(`id: ${encodeInspectionCursor('e1')}`);
    expect(response.body).toContain('event: checkpoint');
    expect(obs.listEvents).toHaveBeenCalledWith({
      cursor: previousCursor,
      limit: 1,
    });
  });

  it('returns stable HTTP errors for invalid cursors and missing records', async () => {
    const obs = service();
    obs.listRegions.mockRejectedValueOnce(new Error('invalid_cursor'));
    obs.executionTrace.mockResolvedValueOnce(null as never);
    obs.artifactLineage.mockResolvedValueOnce(null as never);
    const app = await buildApp({ observabilityService: obs as never });

    const invalid = await app.inject('/api/v1/inspect/regions?cursor=bad');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('invalid_cursor');

    const execution = await app.inject('/api/v1/inspect/executions/missing');
    expect(execution.statusCode).toBe(404);
    expect(execution.json().error.code).toBe('execution_not_found');

    const artifact = await app.inject(
      '/api/v1/inspect/artifacts/missing/lineage',
    );
    expect(artifact.statusCode).toBe(404);
    expect(artifact.json().error.code).toBe('artifact_not_found');
  });
});
