import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createUuidV7,
  migrateToLatest,
  RuntimeRepository,
  TopologyRepository,
} from '../../../packages/db/src/index.js';
import {
  ObservabilityService,
  RegistrationService,
  TemplateInstantiationService,
} from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({ connectionString: base, connectionTimeoutMillis: 10_000 });
const databaseName = `ff_instantiation_observability_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

const schema = {
  apiVersion: 'factory-floor.dev/v1alpha1',
  kind: 'ArtifactSchema',
  metadata: { name: 'checkpoint', version: '1' },
  spec: {
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['completed'],
      properties: { completed: { type: 'boolean' } },
    },
  },
};

const component = {
  apiVersion: 'factory-floor.dev/v1alpha1',
  kind: 'ComponentDefinition',
  metadata: { name: 'observer', version: '1' },
  spec: {
    ports: [
      {
        name: 'checkpoint',
        direction: 'state',
        required: false,
        schema: { name: 'checkpoint', version: '1' },
      },
    ],
  },
};

const template = {
  apiVersion: 'factory-floor.dev/v1alpha1',
  kind: 'Template',
  metadata: { name: 'observable', version: '1' },
  spec: {
    initialTopology: {
      instances: [
        {
          name: 'observer',
          component: 'observer@1',
          initialState: { port: 'checkpoint', value: { completed: false } },
        },
      ],
      connections: [],
    },
  },
};

describe('template-instantiation observability in PostgreSQL', () => {
  const db = createDatabase(testUrl);

  beforeAll(async () => {
    try {
      await admin.query(`create database ${databaseName}`);
      expect((await migrateToLatest(db)).error).toBeUndefined();
    } catch (error) {
      throw new Error(
        `PostgreSQL integration database is required at TEST_DATABASE_URL=${base}. Cause: ${String(error)}`,
      );
    }
  });

  afterAll(async () => {
    await db.destroy();
    await admin.query(`drop database if exists ${databaseName}`).catch(() => undefined);
    await admin.end();
  });

  it('rebuilds the projection and preserves trace and artifact relationships', async () => {
    const registrations = new RegistrationService(db);
    await registrations.registerArtifactSchema(schema);
    await registrations.registerComponentDefinition(component);
    await registrations.registerTemplate(template);
    const region = await new TopologyRepository().createRegion(
      db,
      'observable-region',
      null,
    );
    const result = await new TemplateInstantiationService(db).instantiate({
      requestId: '019bb22e-58b0-7d87-8000-000000000601',
      targetRegionId: region.id,
      template: 'observable@1',
      source: { kind: 'internal', operation: 'observability-test' },
    });
    const instance = await db
      .selectFrom('component_instances')
      .selectAll()
      .where('topology_revision_id', '=', result.revision.id)
      .executeTakeFirstOrThrow();
    const runtime = new RuntimeRepository();
    const command = await runtime.createCommand(db, {
      regionId: region.id,
      commandType: 'observe',
      payload: {},
    });
    const delivery = await runtime.createCommandDelivery(db, {
      regionId: region.id,
      topologyRevisionId: result.revision.id,
      targetComponentInstanceId: instance.id,
      targetPortName: 'checkpoint',
      commandId: command.id,
    });
    const lifecycle = await db
      .selectFrom('regions')
      .select('lifecycle_epoch')
      .where('id', '=', region.id)
      .executeTakeFirstOrThrow();
    const executionId = createUuidV7();
    await db
      .insertInto('executions')
      .values({
        id: executionId,
        delivery_id: delivery.id,
        region_id: region.id,
        component_instance_id: instance.id,
        topology_revision_id: result.revision.id,
        lifecycle_epoch: lifecycle.lifecycle_epoch,
        input_set_digest: 'a'.repeat(64),
        completed_at: null,
        failed_at: null,
        failure: null,
      })
      .execute();

    const service = new ObservabilityService(db);
    const before = await service.projectionStatus();
    const snapshotBefore = before.find(
      (projection) =>
        projection.projectionName === 'template-instantiation-history',
    );
    expect(snapshotBefore?.snapshot).toMatchObject({
      instantiations: 1,
      seededStateVersions: 1,
      firstCreatedAt: expect.any(Date),
      latestCreatedAt: expect.any(Date),
    });

    const rebuild = await service.rebuildProjections(50);
    expect(rebuild.checkpointed).toBeGreaterThan(10);
    const after = await new ObservabilityService(db).projectionStatus();
    expect(
      after.find(
        (projection) =>
          projection.projectionName === 'template-instantiation-history',
      )?.snapshot,
    ).toEqual(snapshotBefore?.snapshot);

    const trace = await service.executionTrace(executionId);
    expect(trace?.templateInstantiations.map((item) => item.id)).toEqual([
      result.instantiationId,
    ]);

    const detail = await service.templateInstantiation(result.instantiationId);
    const artifactId = detail!.initialStates[0]!.artifact.id;
    const lineage = await service.artifactLineage(artifactId);
    expect(lineage?.templateInstantiations.map((item) => item.id)).toEqual([
      result.instantiationId,
    ]);
  });
});
