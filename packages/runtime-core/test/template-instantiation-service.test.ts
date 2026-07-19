/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { TemplateInstantiationService } from '../src/systems/template-instantiation-service.js';

function registeredTemplate(
  name: string,
  spec: Record<string, unknown>,
): Record<string, unknown> {
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
      spec,
    },
  };
}

function parameterizedTemplate(
  name: string,
  configuration: Record<string, unknown> = {},
): Record<string, unknown> {
  return registeredTemplate(name, {
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
  });
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
  const templates = new Map<string, any>([
    [
      'alpha@1',
      parameterizedTemplate('alpha', { mode: { $parameter: 'mode' } }),
    ],
    ['beta@1', parameterizedTemplate('beta')],
  ]);
  const payloadSchema = {
    id: 'schema-payload',
    name: 'payload',
    version: '1',
    content_digest: 's'.repeat(64),
    retired_at: null,
  };
  const componentPorts = new Map<string, any[]>();
  const activeRevisions = new Map<string, any>();
  const revisions: any[] = [];
  const instances: any[] = [];
  const connections: any[] = [];

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
    listPorts: async (_db: unknown, definitionId: string) =>
      componentPorts.get(definitionId.replace(/^definition-/, '')) ?? [],
    findArtifactSchemaById: async (_db: unknown, id: string) =>
      id === payloadSchema.id ? payloadSchema : undefined,
    findArtifactSchema: async (
      _db: unknown,
      name: string,
      version: string,
    ) =>
      name === payloadSchema.name && version === payloadSchema.version
        ? payloadSchema
        : undefined,
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
    createConnection: async (_db: unknown, input: any) => {
      connections.push(input);
    },
    activate: async (_db: unknown, regionId: string, revisionId: string) => {
      const revision = revisions.find((item) => item.id === revisionId);
      activeRevisions.set(regionId, revision);
      const region = regions.get(regionId);
      if (region) region.active_topology_revision_id = revisionId;
    },
  } as any;

  return {
    service: new TemplateInstantiationService(db, definitions, topology),
    templates,
    componentPorts,
    revisions,
    instances,
    connections,
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

  it('requires every region boundary endpoint to be declared by the template contract', async () => {
    const { service, templates, componentPorts, revisions } = harness();
    templates.set(
      'boundary@1',
      registeredTemplate('boundary', {
        initialTopology: {
          instances: [{ name: 'worker', component: 'boundary-worker@1' }],
          connections: [
            { from: 'region.objective', to: 'worker.objective' },
          ],
        },
      }),
    );
    componentPorts.set('boundary-worker', [
      {
        name: 'objective',
        direction: 'input',
        schema_id: 'schema-payload',
      },
    ]);

    await expect(
      service.instantiate({
        targetRegionId: 'region-alpha',
        template: 'boundary@1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_port_reference' });
    expect(revisions).toEqual([]);
  });

  it('resolves same-named component ports by connection direction', async () => {
    const { service, templates, componentPorts, connections } = harness();
    templates.set(
      'duplex@1',
      registeredTemplate('duplex', {
        initialTopology: {
          instances: [{ name: 'worker', component: 'duplex-worker@1' }],
          connections: [{ from: 'worker.value', to: 'worker.value' }],
        },
      }),
    );
    componentPorts.set('duplex-worker', [
      { name: 'value', direction: 'input', schema_id: 'schema-payload' },
      { name: 'value', direction: 'output', schema_id: 'schema-payload' },
    ]);

    await expect(
      service.instantiate({
        targetRegionId: 'region-alpha',
        template: 'duplex@1',
      }),
    ).resolves.toMatchObject({ disposition: 'created' });
    expect(connections).toHaveLength(1);
  });

  it('rejects duplicate topology connections before durable writes', async () => {
    const { service, templates, componentPorts, revisions } = harness();
    templates.set(
      'duplicate@1',
      registeredTemplate('duplicate', {
        initialTopology: {
          instances: [
            { name: 'source', component: 'source-worker@1' },
            { name: 'target', component: 'target-worker@1' },
          ],
          connections: [
            { from: 'source.value', to: 'target.value' },
            { from: 'source.value', to: 'target.value' },
          ],
        },
      }),
    );
    componentPorts.set('source-worker', [
      { name: 'value', direction: 'output', schema_id: 'schema-payload' },
    ]);
    componentPorts.set('target-worker', [
      { name: 'value', direction: 'input', schema_id: 'schema-payload' },
    ]);

    await expect(
      service.instantiate({
        targetRegionId: 'region-alpha',
        template: 'duplicate@1',
      }),
    ).rejects.toMatchObject({ code: 'duplicate_connection' });
    expect(revisions).toEqual([]);
  });

  it('rejects non-numeric resource declarations', async () => {
    const { service, templates, revisions } = harness();
    templates.set(
      'resources@1',
      registeredTemplate('resources', {
        budgets: { monetaryCostUsd: 'unlimited' },
        initialTopology: { instances: [], connections: [] },
      }),
    );

    await expect(
      service.instantiate({
        targetRegionId: 'region-alpha',
        template: 'resources@1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_declaration' });
    expect(revisions).toEqual([]);
  });

  it('requires all-expected fan-in counts to match declared incoming connections', async () => {
    const { service, templates, componentPorts, revisions } = harness();
    templates.set(
      'fan-in@1',
      registeredTemplate('fan-in', {
        initialTopology: {
          instances: [
            { name: 'source', component: 'source-worker@1' },
            { name: 'target', component: 'target-worker@1' },
          ],
          connections: [{ from: 'source.value', to: 'target.value' }],
        },
        fanIn: [
          {
            input: 'target.value',
            completion: { type: 'all-expected', expected: 2 },
          },
        ],
      }),
    );
    componentPorts.set('source-worker', [
      { name: 'value', direction: 'output', schema_id: 'schema-payload' },
    ]);
    componentPorts.set('target-worker', [
      { name: 'value', direction: 'input', schema_id: 'schema-payload' },
    ]);

    await expect(
      service.instantiate({
        targetRegionId: 'region-alpha',
        template: 'fan-in@1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_fan_in_rule' });
    expect(revisions).toEqual([]);
  });
});
