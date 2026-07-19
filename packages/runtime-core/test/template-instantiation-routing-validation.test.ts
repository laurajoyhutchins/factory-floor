/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { TemplateInstantiationService } from '../src/systems/template-instantiation-service.js';

describe('TemplateInstantiationService routing validation', () => {
  // Multiple producers require an explicit aggregation contract so scheduling
  // cannot leave extra ready deliveries behind after consuming one input.
  it('rejects multiple producers for one input without an explicit fan-in rule', async () => {
    const transaction = {};
    const db = {
      transaction: () => ({
        execute: (callback: (trx: unknown) => unknown) => callback(transaction),
      }),
    } as any;
    const schema = {
      id: 'schema-payload',
      name: 'payload',
      version: '1',
      content_digest: 's'.repeat(64),
      retired_at: null,
    };
    const template = {
      id: 'template-routing',
      name: 'routing',
      version: '1',
      content_digest: 't'.repeat(64),
      retired_at: null,
      template: {
        apiVersion: 'factoryfloor.dev/v1alpha1',
        kind: 'Template',
        metadata: { name: 'routing', version: '1' },
        spec: {
          initialTopology: {
            instances: [
              { name: 'source-a', component: 'source@1' },
              { name: 'source-b', component: 'source@1' },
              { name: 'target', component: 'target@1' },
            ],
            connections: [
              { from: 'source-a.value', to: 'target.value' },
              { from: 'source-b.value', to: 'target.value' },
            ],
          },
        },
      },
    };
    const definitions = {
      findTemplate: async () => template,
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
        definitionId === 'definition-source'
          ? [
              {
                name: 'value',
                direction: 'output',
                schema_id: schema.id,
              },
            ]
          : [
              {
                name: 'value',
                direction: 'input',
                schema_id: schema.id,
              },
            ],
      findArtifactSchemaById: async () => schema,
      findArtifactSchema: async () => schema,
      findPolicy: async () => undefined,
    } as any;
    const writes: unknown[] = [];
    const topology = {
      findRegion: async () => ({
        id: 'region-routing',
        name: 'routing',
        lifecycle_status: 'ready',
        active_topology_revision_id: null,
      }),
      activeRevision: async () => undefined,
      createRevision: async (...args: unknown[]) => {
        writes.push(['revision', ...args]);
        return { id: 'revision-routing' };
      },
      createInstance: async (...args: unknown[]) => {
        writes.push(['instance', ...args]);
        return { id: 'instance' };
      },
      createConnection: async (...args: unknown[]) => {
        writes.push(['connection', ...args]);
      },
      activate: async (...args: unknown[]) => {
        writes.push(['activate', ...args]);
      },
    } as any;

    await expect(
      new TemplateInstantiationService(db, definitions, topology).instantiate({
        targetRegionId: 'region-routing',
        template: 'routing@1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_fan_in_rule' });
    expect(writes).toEqual([]);
  });
});
