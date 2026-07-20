import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  migrateToLatest,
  resetDatabaseForDevelopment,
  RuntimeRepository,
  TopologyRepository,
} from '../../../packages/db/src/index.js';
import {
  RegistrationService,
  TemplateInstantiationInspectionService,
  TemplateInstantiationService,
} from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_run_inspection_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

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

const template = {
  apiVersion: 'factory-floor.dev/v1alpha1',
  kind: 'Template',
  metadata: { name: 'seeded', version: '1' },
  spec: {
    initialTopology: {
      instances: [
        {
          name: 'verifier',
          component: 'verify@1',
          initialState: {
            port: 'checkpoint',
            value: { completedSteps: [] },
          },
        },
      ],
      connections: [],
    },
  },
};

describe('run-scoped template-instantiation inspection in PostgreSQL', () => {
  const db = createDatabase(testUrl);
  const registrations = new RegistrationService(db);
  const topology = new TopologyRepository();
  const runtime = new RuntimeRepository();
  let region: { id: string; name: string };

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
    await registrations.registerTemplate(template);
    region = await topology.createRegion(db, 'run-inspection', null);
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('finds the delivered topology before an execution has been created', async () => {
    const instantiation = await new TemplateInstantiationService(db).instantiate({
      requestId: '019bb22e-58b0-7d87-8000-000000000501',
      targetRegionId: region.id,
      template: 'seeded@1',
      source: { kind: 'internal', operation: 'run-inspection-test' },
    });
    const component = await db
      .selectFrom('component_instances')
      .select('id')
      .where('topology_revision_id', '=', instantiation.revision.id)
      .where('name', '=', 'verifier')
      .executeTakeFirstOrThrow();
    const command = await runtime.createCommand(db, {
      regionId: region.id,
      commandType: 'inspection-run',
      payload: {},
    });
    await runtime.createCommandDelivery(db, {
      regionId: region.id,
      topologyRevisionId: instantiation.revision.id,
      targetComponentInstanceId: component.id,
      targetPortName: 'checkpoint',
      commandId: command.id,
    });

    const history = await new TemplateInstantiationInspectionService(db).list(
      { runId: command.id },
      { limit: 10 },
    );

    expect(history.items.map((item) => item.id)).toEqual([
      instantiation.instantiationId,
    ]);
  });
});
