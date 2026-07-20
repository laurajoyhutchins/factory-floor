import Fastify, { type FastifyInstance } from 'fastify';
import type {
  ObservabilityService,
  OperatorCommandService,
  OperatorQueryService,
} from '@factory-floor/runtime-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerInspectionRoutes } from '../src/routes/inspection.js';
import { registerOperatorRoutes } from '../src/routes/operator.js';

const regionId = '019bb22e-58b0-7d87-8000-000000000501';
const runId = '019bb22e-58b0-7d87-8000-000000000502';
const instantiationId = '019bb22e-58b0-7d87-8000-000000000503';

describe('template-instantiation inspection routes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('forwards region-scoped pagination through the supported inspection boundary', async () => {
    const listTemplateInstantiations = vi.fn().mockResolvedValue({
      items: [{ id: instantiationId }],
      nextCursor: 'next',
    });
    app = Fastify();
    await registerInspectionRoutes(app, {
      listTemplateInstantiations,
    } as unknown as ObservabilityService);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/inspect/instantiations?regionId=${regionId}&limit=2&cursor=cursor`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{ id: instantiationId }],
      nextCursor: 'next',
    });
    expect(listTemplateInstantiations).toHaveBeenCalledWith(
      { regionId },
      { cursor: 'cursor', limit: 2 },
    );
  });

  it('returns stable invalid-scope and not-found responses', async () => {
    const listTemplateInstantiations = vi
      .fn()
      .mockRejectedValue(new Error('invalid_scope'));
    const templateInstantiation = vi.fn().mockResolvedValue(null);
    app = Fastify();
    await registerInspectionRoutes(app, {
      listTemplateInstantiations,
      templateInstantiation,
    } as unknown as ObservabilityService);

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/inspect/instantiations',
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({
      error: {
        code: 'invalid_scope',
        message: 'The inspection request is invalid.',
      },
    });

    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/inspect/instantiations/${instantiationId}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: {
        code: 'template_instantiation_not_found',
        message: 'Template instantiation not found.',
      },
    });
  });

  it('exposes run-scoped history through the authenticated operator boundary', async () => {
    const listRunTemplateInstantiations = vi.fn().mockResolvedValue({
      items: [{ id: instantiationId }],
      nextCursor: null,
    });
    app = Fastify();
    await registerOperatorRoutes(
      app,
      {} as OperatorCommandService,
      {
        listRunTemplateInstantiations,
      } as unknown as OperatorQueryService,
    );

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/operator/runs/${runId}/instantiations?limit=3`,
      headers: {
        'x-factory-floor-principal-id': 'operator-1',
        'x-factory-floor-adapter': 'test',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{ id: instantiationId }],
      nextCursor: null,
    });
    expect(listRunTemplateInstantiations).toHaveBeenCalledWith(
      {
        principal: { id: 'operator-1', roles: ['operator'] },
        adapter: 'test',
      },
      runId,
      { limit: 3 },
    );
  });
});
