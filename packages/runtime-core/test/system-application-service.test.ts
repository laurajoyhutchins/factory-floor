/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { SystemApplicationService } from '../src/index.js';

const systemDocument = {
  apiVersion: 'factoryfloor.dev/v1alpha1',
  kind: 'System',
  metadata: { name: 'investigation-demo-m1', version: '0.1.0' },
  spec: {
    rootRegion: { id: 'investigation-demo-root' },
    regions: [
      { id: 'intake', template: 'request-intake@1' },
      { id: 'analysis-work', template: 'bounded-investigation@1' },
      { id: 'publication', template: 'controlled-publication@1' },
    ],
    connections: [],
  },
};

const templateDocument = {
  apiVersion: 'factoryfloor.dev/v1alpha1',
  kind: 'Template',
  metadata: { name: 'bounded-investigation', version: '1' },
  spec: {
    initialTopology: {
      instances: [
        { name: 'retrieve', component: 'retrieve@1' },
        { name: 'verify', component: 'verify@1' },
      ],
      connections: [
        { from: 'region.objective', to: 'retrieve.objective' },
        { from: 'retrieve.evidence', to: 'verify.evidence' },
        { from: 'verify.result', to: 'region.result' },
      ],
    },
  },
};

describe('SystemApplicationService', () => {
  it('routes any topology-bearing region through generic instantiation and preserves static-system conflicts', async () => {
    const transaction = {};
    const db = {
      transaction: () => ({
        execute: (callback: (trx: unknown) => unknown) => callback(transaction),
      }),
    } as any;
    const roots = new Map<string, any>();
    const children = new Map<string, any>();
    const activeRevisions = new Map<string, any>();
    const revisions: any[] = [];
    const createdInstances: any[] = [];
    const createdConnections: any[] = [];

    const topology = {
      findRegion: async (_db: unknown, id: string) =>
        [...roots.values(), ...children.values()].find(
          (region) => region.id === id,
        ),
      findRoot: async (_db: unknown, name: string) => roots.get(name),
      createRegion: async (
        _db: unknown,
        name: string,
        parentRegionId: string | null,
      ) => {
        const row = {
          id: `region-${name}`,
          name,
          parent_region_id: parentRegionId,
          lifecycle_status: 'ready',
          active_topology_revision_id: null,
        };
        if (parentRegionId === null) roots.set(name, row);
        else children.set(`${parentRegionId}:${name}`, row);
        return row;
      },
      findChild: async (_db: unknown, parent: string, name: string) =>
        children.get(`${parent}:${name}`),
      activeRevision: async (_db: unknown, regionId: string) =>
        activeRevisions.get(regionId),
      createRevision: async (
        _db: unknown,
        regionId: string,
        digest: string,
        storedTopology: unknown,
      ) => {
        const row = {
          id: 'revision-1',
          region_id: regionId,
          content_digest: digest,
          topology: storedTopology,
        };
        revisions.push(row);
        return row;
      },
      createInstance: async (_db: unknown, input: any) => {
        createdInstances.push(input);
        return { id: `instance-${input.name}`, ...input };
      },
      createConnection: async (_db: unknown, input: any) => {
        createdConnections.push(input);
      },
      activate: async (_db: unknown, regionId: string, revisionId: string) => {
        activeRevisions.set(
          regionId,
          revisions.find((revision) => revision.id === revisionId),
        );
      },
    } as any;

    const schema = {
      id: 'schema-payload',
      name: 'payload',
      version: '1',
      content_digest: 's'.repeat(64),
      retired_at: null,
    };
    const definitions = {
      findTemplate: async (_db: unknown, name: string) =>
        name === 'bounded-investigation'
          ? {
              id: 'template-bounded-investigation',
              name: 'bounded-investigation',
              version: '1',
              template: templateDocument,
              content_digest: 't'.repeat(64),
              retired_at: null,
            }
          : undefined,
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
        definitionId.endsWith('retrieve')
          ? [
              {
                name: 'objective',
                direction: 'input',
                schema_id: schema.id,
              },
              {
                name: 'evidence',
                direction: 'output',
                schema_id: schema.id,
              },
            ]
          : [
              {
                name: 'evidence',
                direction: 'input',
                schema_id: schema.id,
              },
              {
                name: 'result',
                direction: 'output',
                schema_id: schema.id,
              },
            ],
      findArtifactSchemaById: async () => schema,
      findArtifactSchema: async () => schema,
      findPolicy: async () => undefined,
    } as any;

    const service = new SystemApplicationService(db, definitions, topology);
    const first = await service.apply(systemDocument);
    const second = await service.apply(systemDocument);

    expect(first.disposition).toBe('created');
    expect(first.regions).toHaveLength(4);
    expect(createdInstances.map((instance) => instance.name)).toEqual([
      'retrieve',
      'verify',
    ]);
    expect(createdConnections).toHaveLength(1);
    expect(second).toMatchObject({
      disposition: 'existing',
      digest: first.digest,
    });
    expect(createdInstances).toHaveLength(2);
    expect(activeRevisions.has('region-analysis-work')).toBe(true);

    await expect(
      service.apply({
        ...systemDocument,
        spec: {
          ...systemDocument.spec,
          connections: [
            { from: 'intake.accepted', to: 'analysis-work.objective' },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'template_instantiation_conflict' });
    expect(createdInstances).toHaveLength(2);
  });
});
