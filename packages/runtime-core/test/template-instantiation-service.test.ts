/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { TemplateInstantiationService } from '../src/systems/template-instantiation-service.js';

function template(name: string, configuration: Record<string, unknown> = {}) {
  return {
    id: `template-${name}`,
    name,
    version: '1',
    content_digest: name.padEnd(64, name[0] ?? 'a').slice(0, 64),
    retired_at: null,
    template: {
      apiVersion: 'factoryfloor.dev/v1alpha1',
      kind: 'Template',
      metadata: { name, version: '1' },
      spec: {
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['mode'],
          properties: {
            mode: { type: 'string', enum: ['strict', 'fast'] },
          },
        },
        initialTopology: {
          instances: [
            {
              name: 'worker',
              component: `${name}-worker@1`,
              configuration,
            },
          ],
          connections: [],
        },
      },
    },
  };
}

function harness() {
  const transaction = {};
  const db = {
    transaction: () => ({
      execute: (callback: (trx: unknown) => unknown) => callback(transaction),
    }),
  } as any;
  const regions = new Map<string, any>([
    [
      'region-alpha',
      {
        id: 'region-alpha',
        name: 'alpha',
        lifecycle_status: 'ready',
        active_topology_revision_id: null,
      },
    ],
    [
      'region-beta',
      {
        id: 'region-beta',
        name: 'beta',
        lifecycle_status: 'ready',
        active_topology_revision_id: null,
      },
    ],
  ]);
  const templates = new Map([
    ['alpha@1', template('alpha', { mode: { $parameter: 'mode' } })],
    ['beta@1', template('beta')],
  ]);
  const activeRevisions = new Map<string, any>();
  const revisions: any[] = [];
  const instances: any[] = [];

  const definitions = {
    findTemplate: async (_db: unknown, name: string, version: string) =>
      templates.get(`${name}@${version}`),
    findComponentDefinition: async (
      _db: unknown,
      name: string,
      version: string,
    ) => ({
      id: `definition-${name}`,
      name,
      version,
      content_digest: `${name}-${version}`.padEnd(64, 'd').slice(0, 64),
      retired_at: null,
    }),
    listPorts: async () => [],
    findArtifactSchemaById: async () => undefined,
    findArtifactSchema: async () => undefined,
    findPolicy: async () => undefined,
  } as any;

  const topology = {
    findRegion: async (_db: unknown, id: string) => regions.get(id),
    activeRevision: async (_db: unknown, regionId: string) =>
      activeRevisions.get(regionId),
    createRevision: async (
      _db: unknown,
      regionId: string,
      digest: string,
      storedTopology: unknown,
    ) => {
      const row = {
        id: `revision-${regionId}`,
        region_id: regionId,
        content_digest: digest,
        topology: storedTopology,
      };
      revisions.push(row);
      return row;
    },
    createInstance: async (_db: unknown, input: any) => {
      const row = { id: `instance-${input.regionId}-${input.name}`, ...input };
      instances.push(row);
      return row;
    },
    createConnection: async () => undefined,
    activate: async (_db: unknown, regionId: string, revisionId: string) => {
      const revision = revisions.find((item) => item.id === revisionId);
      activeRevisions.set(regionId, revision);
      const region = regions.get(regionId);
      if (region) region.active_topology_revision_id = revisionId;
    },
  } as any;

  return {
    service: new TemplateInstantiationService(db, definitions, topology),
    revisions,
    instances,
  };
}

describe('TemplateInstantiationService', () => {
  it('instantiates different registered templates into distinct target regions through one service', async () => {
    const { service, revisions, instances } = harness();

    const alpha = await service.instantiate({
      targetRegionId: 'region-alpha',
      template: 'alpha@1',
      parameters: { mode: 'strict' },
      componentConfiguration: { worker: { attempts: 2 } },
    });
    const beta = await service.instantiate({
      targetRegionId: 'region-beta',
      template: 'beta@1',
      parameters: { mode: 'fast' },
    });

    expect(alpha.disposition).toBe('created');
    expect(beta.disposition).toBe('created');
    expect(alpha.digest).not.toBe(beta.digest);
    expect(revisions).toHaveLength(2);
    expect(instances).toEqual([
      expect.objectContaining({
        regionId: 'region-alpha',
        name: 'worker',
        configuration: { mode: 'strict', attempts: 2 },
      }),
      expect.objectContaining({
        regionId: 'region-beta',
        name: 'worker',
        configuration: {},
      }),
    ]);
  });

  it('returns the existing revision for an identical repeated request', async () => {
    const { service, revisions, instances } = harness();
    const request = {
      targetRegionId: 'region-alpha',
      template: 'alpha@1',
      parameters: { mode: 'strict' },
    };

    const first = await service.instantiate(request);
    const second = await service.instantiate(request);

    expect(first.disposition).toBe('created');
    expect(second).toMatchObject({
      disposition: 'existing',
      digest: first.digest,
    });
    expect(revisions).toHaveLength(1);
    expect(instances).toHaveLength(1);
  });

  it('rejects invalid parameters before creating topology records', async () => {
    const { service, revisions, instances } = harness();

    await expect(
      service.instantiate({
        targetRegionId: 'region-alpha',
        template: 'alpha@1',
        parameters: { mode: 'unsupported' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_template_parameters' });
    expect(revisions).toEqual([]);
    expect(instances).toEqual([]);
  });
});
