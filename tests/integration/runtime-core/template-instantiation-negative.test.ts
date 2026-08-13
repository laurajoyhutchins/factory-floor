/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactRepository,
  ComponentStateRepository,
  createDatabase,
  createUuidV7,
  DefinitionRepository,
  migrateToLatest,
  resetDatabaseForDevelopment,
  TemplateInstantiationRepository,
  TopologyRepository,
  type RuntimeDb,
} from '../../../packages/db/src/index.js';
import {
  RegistrationService,
  TemplateInstantiationService,
} from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_template_negative_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

const payloadSchema = {
  apiVersion: 'factory-floor.dev/v1alpha1',
  kind: 'ArtifactSchema',
  metadata: { name: 'payload', version: '1' },
  spec: { schema: { type: 'object', additionalProperties: true } },
};

const alternateSchema = {
  apiVersion: 'factory-floor.dev/v1alpha1',
  kind: 'ArtifactSchema',
  metadata: { name: 'alternate', version: '1' },
  spec: { schema: { type: 'string' } },
};

const producerDefinition = {
  apiVersion: 'factory-floor.dev/v1alpha1',
  kind: 'ComponentDefinition',
  metadata: { name: 'producer', version: '1' },
  spec: {
    ports: [
      {
        name: 'value',
        direction: 'output',
        required: true,
        schema: { name: 'payload', version: '1' },
      },
    ],
  },
};

const workerDefinition = {
  apiVersion: 'factory-floor.dev/v1alpha1',
  kind: 'ComponentDefinition',
  metadata: { name: 'worker', version: '1' },
  spec: {
    ports: [
      {
        name: 'value',
        direction: 'input',
        required: true,
        schema: { name: 'payload', version: '1' },
      },
    ],
  },
};

function templateDocument(name: string, patch: Record<string, unknown> = {}) {
  return {
    apiVersion: 'factory-floor.dev/v1alpha1',
    kind: 'Template',
    metadata: { name, version: '1' },
    spec: {
      initialTopology: {
        instances: [
          { name: 'producer', component: 'producer@1' },
          { name: 'worker', component: 'worker@1' },
        ],
        connections: [{ from: 'producer.value', to: 'worker.value' }],
      },
      ...patch,
    },
  };
}

class FailingActivationTopologyRepository extends TopologyRepository {
  override async activate(db: RuntimeDb, regionId: string, revisionId: string) {
    await super.activate(db, regionId, revisionId);
    throw new Error('injected activation failure');
  }
}

async function expectNoPublishedInstantiation(
  db: ReturnType<typeof createDatabase>,
) {
  const revisions = await db
    .selectFrom('topology_revisions')
    .selectAll()
    .execute();
  const instances = await db
    .selectFrom('component_instances')
    .selectAll()
    .execute();
  const connections = await db.selectFrom('connections').selectAll().execute();
  const history = await db
    .selectFrom('template_instantiations')
    .selectAll()
    .execute();
  const artifacts = await db.selectFrom('artifacts').selectAll().execute();
  const stateVersions = await db
    .selectFrom('component_state_versions')
    .selectAll()
    .execute();

  expect(revisions).toEqual([]);
  expect(instances).toEqual([]);
  expect(connections).toEqual([]);
  expect(history).toEqual([]);
  expect(artifacts).toEqual([]);
  expect(stateVersions).toEqual([]);
}

describe('PostgreSQL template instantiation negative matrix', () => {
  const db = createDatabase(testUrl);
  const registrations = new RegistrationService(db);
  const topology = new TopologyRepository();
  let regionId: string;

  beforeAll(async () => {
    try {
      await admin.query(`create database ${databaseName}`);
      expect((await migrateToLatest(db)).error).toBeUndefined();
    } catch (error) {
      throw new Error(
        `PostgreSQL integration database is required at ` +
          `TEST_DATABASE_URL=${base}. Cause: ${String(error)}`,
      );
    }
  });

  beforeEach(async () => {
    const reset = await resetDatabaseForDevelopment(db, 'test');
    expect(reset.error).toBeUndefined();
    await registrations.registerArtifactSchema(payloadSchema);
    await registrations.registerComponentDefinition(producerDefinition);
    await registrations.registerComponentDefinition(workerDefinition);
    await registrations.registerTemplate(templateDocument('baseline'));
    regionId = (await topology.createRegion(db, 'negative-region', null)).id;
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  async function expectRejectedWithoutPublication(
    request: Parameters<TemplateInstantiationService['instantiate']>[0],
    code: string,
    service = new TemplateInstantiationService(db),
  ) {
    await expect(service.instantiate(request)).rejects.toMatchObject({ code });
    await expectNoPublishedInstantiation(db);
  }

  it('rejects a missing template without publication', async () => {
    await expectRejectedWithoutPublication(
      { targetRegionId: regionId, template: 'missing@1' },
      'template_not_found',
    );
  });

  it('rejects a retired template without publication', async () => {
    await db
      .updateTable('templates')
      .set({ retired_at: new Date() })
      .where('name', '=', 'baseline')
      .execute();

    await expectRejectedWithoutPublication(
      { targetRegionId: regionId, template: 'baseline@1' },
      'template_retired',
    );
  });

  it('rejects a missing component without publication', async () => {
    await registrations.registerTemplate(
      templateDocument('missing-component', {
        initialTopology: {
          instances: [{ name: 'missing', component: 'missing@1' }],
          connections: [],
        },
      }),
    );

    await expectRejectedWithoutPublication(
      { targetRegionId: regionId, template: 'missing-component@1' },
      'component_definition_not_found',
    );
  });

  it('rejects a retired component without publication', async () => {
    await db
      .updateTable('component_definitions')
      .set({ retired_at: new Date() })
      .where('name', '=', 'producer')
      .execute();

    await expectRejectedWithoutPublication(
      { targetRegionId: regionId, template: 'baseline@1' },
      'component_definition_retired',
    );
  });

  it('rejects a missing schema contract without publication', async () => {
    await registrations.registerTemplate(
      templateDocument('missing-schema', {
        inputs: [{ port: 'objective', schema: 'missing@1' }],
      }),
    );

    await expectRejectedWithoutPublication(
      { targetRegionId: regionId, template: 'missing-schema@1' },
      'artifact_schema_not_found',
    );
  });

  it('rejects a retired component port schema without publication', async () => {
    await db
      .updateTable('artifact_schemas')
      .set({ retired_at: new Date() })
      .where('name', '=', 'payload')
      .execute();

    await expectRejectedWithoutPublication(
      { targetRegionId: regionId, template: 'baseline@1' },
      'artifact_schema_retired',
    );
  });

  it('rejects a missing policy without publication', async () => {
    await registrations.registerTemplate(
      templateDocument('missing-policy', { policies: ['missing-policy@1'] }),
    );

    await expectRejectedWithoutPublication(
      { targetRegionId: regionId, template: 'missing-policy@1' },
      'policy_not_found',
    );
  });

  it('rejects a retired policy without publication', async () => {
    await registrations.registerPolicy({
      apiVersion: 'factory-floor.dev/v1alpha1',
      kind: 'Policy',
      metadata: { name: 'retired-policy', version: '1' },
      spec: {},
    });
    await db
      .updateTable('policies')
      .set({ retired_at: new Date() })
      .where('name', '=', 'retired-policy')
      .execute();
    await registrations.registerTemplate(
      templateDocument('retired-policy-template', {
        policies: ['retired-policy@1'],
      }),
    );

    await expectRejectedWithoutPublication(
      { targetRegionId: regionId, template: 'retired-policy-template@1' },
      'policy_retired',
    );
  });

  it('rejects a missing capability without publication', async () => {
    await registrations.registerTemplate(
      templateDocument('missing-capability', {
        capabilities: ['missing-capability@1'],
      }),
    );

    await expectRejectedWithoutPublication(
      { targetRegionId: regionId, template: 'missing-capability@1' },
      'capability_not_found',
    );
  });

  it('rejects a retired capability without publication', async () => {
    await db
      .insertInto('capabilities')
      .values({
        id: createUuidV7(),
        name: 'retired-capability',
        version: '1',
        content_digest: 'c'.repeat(64),
        retired_at: new Date(),
        capability_type: 'test',
        configuration: {},
      })
      .execute();
    await registrations.registerTemplate(
      templateDocument('retired-capability-template', {
        capabilities: ['retired-capability@1'],
      }),
    );

    await expectRejectedWithoutPublication(
      {
        targetRegionId: regionId,
        template: 'retired-capability-template@1',
      },
      'capability_retired',
    );
  });

  it('rejects incompatible port schemas without publication', async () => {
    await registrations.registerArtifactSchema(alternateSchema);
    await registrations.registerComponentDefinition({
      apiVersion: 'factory-floor.dev/v1alpha1',
      kind: 'ComponentDefinition',
      metadata: { name: 'alternate-worker', version: '1' },
      spec: {
        ports: [
          {
            name: 'value',
            direction: 'input',
            required: true,
            schema: { name: 'alternate', version: '1' },
          },
        ],
      },
    });
    await registrations.registerTemplate(
      templateDocument('incompatible', {
        initialTopology: {
          instances: [
            { name: 'producer', component: 'producer@1' },
            { name: 'worker', component: 'alternate-worker@1' },
          ],
          connections: [{ from: 'producer.value', to: 'worker.value' }],
        },
      }),
    );

    await expectRejectedWithoutPublication(
      { targetRegionId: regionId, template: 'incompatible@1' },
      'incompatible_port_schema',
    );
  });

  it('rejects invalid parameters without publication', async () => {
    await registrations.registerTemplate(
      templateDocument('parameterized', {
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['mode'],
          properties: { mode: { type: 'string', enum: ['strict', 'fast'] } },
        },
      }),
    );

    await expectRejectedWithoutPublication(
      {
        targetRegionId: regionId,
        template: 'parameterized@1',
        parameters: { mode: 'unsupported' },
      },
      'invalid_template_parameters',
    );
  });

  it('rejects invalid component configuration without publication', async () => {
    await expectRejectedWithoutPublication(
      {
        targetRegionId: regionId,
        template: 'baseline@1',
        componentConfiguration: { missing: { attempts: 2 } },
      },
      'invalid_component_configuration',
    );
  });

  it('rejects an ineligible region without publication', async () => {
    await db
      .updateTable('regions')
      .set({ lifecycle_status: 'running' })
      .where('id', '=', regionId)
      .execute();

    await expectRejectedWithoutPublication(
      { targetRegionId: regionId, template: 'baseline@1' },
      'region_not_eligible',
    );
  });

  it('rolls back revision, instances, connections, and history when activation fails', async () => {
    const failingTopology = new FailingActivationTopologyRepository();
    const service = new TemplateInstantiationService(
      db,
      new DefinitionRepository(),
      failingTopology,
      new TemplateInstantiationRepository(),
      new ArtifactRepository(),
      new ComponentStateRepository(),
    );

    await expect(
      service.instantiate({
        targetRegionId: regionId,
        template: 'baseline@1',
      }),
    ).rejects.toThrow('injected activation failure');
    await expectNoPublishedInstantiation(db);

    const region = await db
      .selectFrom('regions')
      .select(['active_topology_revision_id', 'lifecycle_status'])
      .where('id', '=', regionId)
      .executeTakeFirstOrThrow();
    expect(region).toEqual({
      active_topology_revision_id: null,
      lifecycle_status: 'ready',
    });
  });
});
