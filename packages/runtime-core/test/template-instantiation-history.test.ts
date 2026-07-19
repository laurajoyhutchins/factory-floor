/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { TemplateInstantiationService } from '../src/systems/durable-template-instantiation-service.js';

const requestA = '019bb22e-58b0-7d87-8000-000000000101';
const requestB = '019bb22e-58b0-7d87-8000-000000000102';

function harness() {
  const transaction = {};
  const db = {
    transaction: () => ({
      execute: (callback: (trx: unknown) => unknown) => callback(transaction),
    }),
  } as any;
  const region = {
    id: 'region-alpha',
    name: 'alpha',
    lifecycle_status: 'ready',
    active_topology_revision_id: null as string | null,
  };
  const template = {
    id: 'template-alpha',
    name: 'alpha',
    version: '1',
    content_digest: 'a'.repeat(64),
    retired_at: null,
    template: {
      apiVersion: 'factoryfloor.dev/v1alpha1',
      kind: 'Template',
      metadata: { name: 'alpha', version: '1' },
      spec: {
        initialTopology: { instances: [], connections: [] },
      },
    },
  };
  let activeRevision: any;
  const revisions: any[] = [];
  const records: any[] = [];

  const definitions = {
    findTemplate: async () => template,
  } as any;
  const topology = {
    findRegion: async () => region,
    activeRevision: async () => activeRevision,
    createRevision: async (
      _db: unknown,
      regionId: string,
      digest: string,
      storedTopology: unknown,
    ) => {
      const revision = {
        id: `revision-${revisions.length + 1}`,
        region_id: regionId,
        content_digest: digest,
        topology: storedTopology,
      };
      revisions.push(revision);
      return revision;
    },
    createInstance: async () => {
      throw new Error('empty template must not create component instances');
    },
    createConnection: async () => {
      throw new Error('empty template must not create connections');
    },
    activate: async (_db: unknown, _regionId: string, revisionId: string) => {
      activeRevision = revisions.find((revision) => revision.id === revisionId);
      region.active_topology_revision_id = revisionId;
    },
  } as any;
  const instantiations = {
    findByRequestId: async (_db: unknown, requestId: string) =>
      records.find((record) => record.request_id === requestId),
    create: async (_db: unknown, input: any) => {
      const record = {
        id: `instantiation-${records.length + 1}`,
        request_id: input.requestId,
        request_digest: input.requestDigest,
        target_region_id: input.targetRegionId,
        topology_revision_id: input.topologyRevisionId,
        template_id: input.templateId,
        effective_digest: input.effectiveDigest,
        parameters: input.parameters,
        component_configuration: input.componentConfiguration,
        source: input.source,
        referenced_definitions: input.referencedDefinitions,
        initial_disposition: input.initialDisposition,
      };
      records.push(record);
      return record;
    },
  } as any;

  return {
    service: new TemplateInstantiationService(
      db,
      definitions,
      topology,
      instantiations,
    ),
    records,
    revisions,
  };
}

function request(requestId = requestA, sourceName = 'first') {
  return {
    requestId,
    targetRegionId: 'region-alpha',
    template: 'alpha@1',
    source: { kind: 'internal', operation: sourceName },
  };
}

describe('durable template instantiation history', () => {
  it('creates one atomic durable record with the new topology', async () => {
    const { service, records, revisions } = harness();

    const result = await service.instantiate(request());

    expect(result).toMatchObject({
      disposition: 'created',
      instantiationId: 'instantiation-1',
    });
    expect(revisions).toHaveLength(1);
    expect(records).toEqual([
      expect.objectContaining({
        id: 'instantiation-1',
        request_id: requestA,
        target_region_id: 'region-alpha',
        topology_revision_id: 'revision-1',
        template_id: 'template-alpha',
        effective_digest: result.digest,
        initial_disposition: 'created',
      }),
    ]);
    expect(records[0].request_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(records[0].referenced_definitions).toEqual([
      expect.objectContaining({
        kind: 'template',
        id: 'template-alpha',
      }),
    ]);
  });

  it('reuses one record for an identical retry of the same request identity', async () => {
    const { service, records, revisions } = harness();

    const first = await service.instantiate(request());
    const second = await service.instantiate(request());

    expect(first.disposition).toBe('created');
    expect(second).toMatchObject({
      disposition: 'existing',
      instantiationId: first.instantiationId,
      digest: first.digest,
    });
    expect(records).toHaveLength(1);
    expect(revisions).toHaveLength(1);
  });

  it('records a distinct existing outcome for a different request identity', async () => {
    const { service, records, revisions } = harness();

    const first = await service.instantiate(request(requestA));
    const second = await service.instantiate(request(requestB));

    expect(first.disposition).toBe('created');
    expect(second).toMatchObject({
      disposition: 'existing',
      instantiationId: 'instantiation-2',
      digest: first.digest,
    });
    expect(records.map((record) => record.initial_disposition)).toEqual([
      'created',
      'existing',
    ]);
    expect(revisions).toHaveLength(1);
  });

  it('rejects conflicting reuse of a request identity without new writes', async () => {
    const { service, records, revisions } = harness();

    await service.instantiate(request(requestA, 'first'));
    await expect(
      service.instantiate(request(requestA, 'changed')),
    ).rejects.toMatchObject({ code: 'template_instantiation_conflict' });

    expect(records).toHaveLength(1);
    expect(revisions).toHaveLength(1);
  });
});
