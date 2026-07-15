/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest, SystemApplicationService } from '../src/index.js';

const systemDocument = {
  apiVersion: 'factoryfloor.dev/v1alpha1',
  kind: 'System',
  metadata: { name: 'investigation-demo-m1', version: '0.1.0' },
  spec: {
    rootRegion: { id: 'investigation-demo-root' },
    regions: [
      { id: 'intake', template: 'request-intake@1' },
      { id: 'investigation', template: 'bounded-investigation@1' },
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
  it('resolves the registered investigation template and applies its static topology idempotently', async () => {
    const transaction = {};
    const db = { transaction: () => ({ execute: (callback: (trx: unknown) => unknown) => callback(transaction) }) } as any;
    const roots = new Map<string, any>();
    const children = new Map<string, any>();
    let activeRevision: any;
    const createdInstances: any[] = [];
    const createdConnections: any[] = [];

    const topology = {
      findRoot: async (_db: unknown, name: string) => roots.get(name),
      createRegion: async (_db: unknown, name: string, parentRegionId: string | null) => {
        const row = { id: `region-${name}`, name, parent_region_id: parentRegionId };
        if (parentRegionId === null) roots.set(name, row);
        else children.set(`${parentRegionId}:${name}`, row);
        return row;
      },
      findChild: async (_db: unknown, parent: string, name: string) => children.get(`${parent}:${name}`),
      activeRevision: async () => activeRevision,
      createRevision: async (_db: unknown, regionId: string, digest: string, storedTopology: unknown) => ({
        id: 'revision-1',
        region_id: regionId,
        content_digest: digest,
        topology: storedTopology,
      }),
      createInstance: async (_db: unknown, input: any) => {
        createdInstances.push(input);
        return { id: `instance-${input.name}`, ...input };
      },
      createConnection: async (_db: unknown, input: any) => {
        createdConnections.push(input);
      },
      activate: async (_db: unknown, _regionId: string, _revisionId: string) => {
        activeRevision = { content_digest: canonicalJsonDigest({ system: systemDocument, templateDigest: 't'.repeat(64) }) };
      },
    } as any;

    const definitions = {
      findTemplate: async () => ({ template: templateDocument, content_digest: 't'.repeat(64) }),
      findComponentDefinition: async (_db: unknown, name: string) => ({ id: `definition-${name}` }),
      listPorts: async (_db: unknown, definitionId: string) => definitionId.endsWith('retrieve')
        ? [{ name: 'objective' }, { name: 'evidence' }]
        : [{ name: 'evidence' }, { name: 'result' }],
    } as any;

    const service = new SystemApplicationService(db, definitions, topology);
    const first = await service.apply(systemDocument);
    const second = await service.apply(systemDocument);

    expect(first.disposition).toBe('created');
    expect(first.regions).toHaveLength(4);
    expect(createdInstances.map((instance) => instance.name)).toEqual(['retrieve', 'verify']);
    expect(createdConnections).toHaveLength(1);
    expect(second).toMatchObject({ disposition: 'existing', digest: first.digest });
    expect(createdInstances).toHaveLength(2);
  });
});
