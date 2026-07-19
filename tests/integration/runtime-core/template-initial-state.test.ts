import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ComponentStateRepository,
  createDatabase,
  createUuidV7,
  migrateToLatest,
  resetDatabaseForDevelopment,
  RuntimeRepository,
  TopologyRepository,
} from '../../../packages/db/src/index.js';
import {
  RegistrationService,
  TemplateInstantiationService,
  WorkerProtocolService,
} from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_template_state_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

const requestA = '019bb22e-58b0-7d87-8000-000000000301';
const requestB = '019bb22e-58b0-7d87-8000-000000000302';

const stateSchema = {
  apiVersion: 'factory-floor.dev/v1alpha1',
  kind: 'ArtifactSchema',
  metadata: { name: 'checkpoint', version: '1' },
  spec: {
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['completedSteps'],
      properties: {
        completedSteps: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

const componentDefinition = {
  apiVersion: 'factory-floor.dev/v1alpha1',
  kind: 'ComponentDefinition',
  metadata: { name: 'verify', version: '1' },
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

function templateDocument(name: string, completedSteps: unknown) {
  return {
    apiVersion: 'factory-floor.dev/v1alpha1',
    kind: 'Template',
    metadata: { name, version: '1' },
    spec: {
      initialTopology: {
        instances: [
          {
            name: 'verifier',
            component: 'verify@1',
            initialState: {
              port: 'checkpoint',
              value: { completedSteps },
            },
          },
        ],
        connections: [],
      },
    },
  };
}

describe('template-provided initial state in PostgreSQL', () => {
  const db = createDatabase(testUrl);
  const registrations = new RegistrationService(db);
  const topology = new TopologyRepository();
  const runtime = new RuntimeRepository();
  let regionId: string;

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

  beforeEach(async () => {
    expect(
      (await resetDatabaseForDevelopment(db, 'test')).error,
    ).toBeUndefined();
    await registrations.registerArtifactSchema(stateSchema);
    await registrations.registerComponentDefinition(componentDefinition);
    await registrations.registerTemplate(templateDocument('seeded', []));
    regionId = (await topology.createRegion(db, 'seeded-region', null)).id;
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('publishes one atomic seed version and exposes it after a fresh service construction', async () => {
    const service = new TemplateInstantiationService(db);
    const source = { kind: 'internal', operation: 'integration-test' };

    const first = await service.instantiate({
      requestId: requestA,
      targetRegionId: regionId,
      template: 'seeded@1',
      source,
    });
    const retry = await service.instantiate({
      requestId: requestA,
      targetRegionId: regionId,
      template: 'seeded@1',
      source,
    });
    const second = await service.instantiate({
      requestId: requestB,
      targetRegionId: regionId,
      template: 'seeded@1',
      source,
    });

    expect(retry).toMatchObject({
      disposition: 'existing',
      instantiationId: first.instantiationId,
    });
    expect(second).toMatchObject({ disposition: 'existing' });

    const versions = await db
      .selectFrom('component_state_versions')
      .selectAll()
      .execute();
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version_number: 1,
      state_port_name: 'checkpoint',
      source_kind: 'template_instantiation',
      origin_template_instantiation_id: first.instantiationId,
    });
    expect(
      await db
        .selectFrom('template_instantiation_state_links')
        .selectAll()
        .execute(),
    ).toHaveLength(2);
    expect(
      await db.selectFrom('artifact_inline_payloads').selectAll().execute(),
    ).toHaveLength(1);

    const component = await db
      .selectFrom('component_instances')
      .selectAll()
      .where('topology_revision_id', '=', first.revision.id)
      .where('name', '=', 'verifier')
      .executeTakeFirstOrThrow();
    const latest = await new ComponentStateRepository().readLatestState(
      db,
      component.id,
    );
    expect(latest).toMatchObject({
      state_port_name: 'checkpoint',
      version_number: 1,
      inline_payload: { completedSteps: [] },
    });

    const command = await runtime.createCommand(db, {
      regionId,
      commandType: 'state-envelope-probe',
      payload: {},
    });
    const delivery = await runtime.createCommandDelivery(db, {
      regionId,
      topologyRevisionId: first.revision.id,
      targetComponentInstanceId: component.id,
      targetPortName: 'checkpoint',
      commandId: command.id,
    });
    const executionId = createUuidV7();
    await db
      .insertInto('executions')
      .values({
        id: executionId,
        delivery_id: delivery.id,
        region_id: regionId,
        component_instance_id: component.id,
        topology_revision_id: first.revision.id,
        input_set_digest: 'd'.repeat(64),
        completed_at: null,
        failed_at: null,
        failure: null,
      })
      .execute();

    const envelope = await new WorkerProtocolService(db, undefined, {
      leaseDurationMs: 30_000,
    }).buildEnvelope({
      executionId,
      attemptId: createUuidV7(),
      attemptNumber: 1,
      leaseToken: 'state-envelope-probe',
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      inputs: [],
    });
    expect(envelope.state).toMatchObject({
      artifactId: versions[0]!.artifact_id,
      schemaId: versions[0]!.schema_id,
      provenance: {
        kind: 'templateInstantiation',
        instantiationId: first.instantiationId,
      },
    });
  });

  it('rejects invalid seed content without publishing topology or history', async () => {
    await registrations.registerTemplate(
      templateDocument('invalid-seed', 'not-an-array'),
    );
    const invalidRegionId = (
      await topology.createRegion(db, 'invalid-seed-region', null)
    ).id;

    const beforeArtifacts = await db
      .selectFrom('artifacts')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();

    await expect(
      new TemplateInstantiationService(db).instantiate({
        requestId: requestA,
        targetRegionId: invalidRegionId,
        template: 'invalid-seed@1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_declaration' });

    expect(
      await db
        .selectFrom('topology_revisions')
        .selectAll()
        .where('region_id', '=', invalidRegionId)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom('template_instantiations')
        .selectAll()
        .where('target_region_id', '=', invalidRegionId)
        .execute(),
    ).toEqual([]);
    expect(
      await db.selectFrom('component_state_versions').selectAll().execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom('artifacts')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeArtifacts);
  });
});
