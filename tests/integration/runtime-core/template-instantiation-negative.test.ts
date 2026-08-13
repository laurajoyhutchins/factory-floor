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

function schemaDocument(name: string, schema: Record<string, unknown>) {
  return {
    apiVersion: 'factory-floor.dev/v1alpha1',
    kind: 'ArtifactSchema',
    metadata: { name, version: '1' },
    spec: { schema },
  };
}

function componentDocument(
  name: string,
  direction: 'input' | 'output',
  schema: string,
) {
  return {
    apiVersion: 'factory-floor.dev/v1alpha1',
    kind: 'ComponentDefinition',
    metadata: { name, version: '1' },
    spec: {
      ports: [
        {
          name: 'value',
          direction,
          required: true,
          schema: { name: schema, version: '1' },
        },
      ],
    },
  };
}

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

async function expectNoPublication(db: ReturnType<typeof createDatabase>) {
  for (const table of [
    'topology_revisions',
    'component_instances',
    'connections',
    'template_instantiations',
    'artifacts',
    'component_state_versions',
  ] as const) {
    expect(await db.selectFrom(table).selectAll().execute()).toEqual([]);
  }
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
    expect(
      (await resetDatabaseForDevelopment(db, 'test')).error,
    ).toBeUndefined();
    await registrations.registerArtifactSchema(
      schemaDocument('payload', { type: 'object', additionalProperties: true }),
    );
    await registrations.registerComponentDefinition(
      componentDocument('producer', 'output', 'payload'),
    );
    await registrations.registerComponentDefinition(
      componentDocument('worker', 'input', 'payload'),
    );
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

  async function rejectWithoutPublication(
    request: Parameters<TemplateInstantiationService['instantiate']>[0],
    code: string,
    service = new TemplateInstantiationService(db),
  ) {
    await expect(service.instantiate(request)).rejects.toMatchObject({ code });
    await expectNoPublication(db);
  }

  it('rejects missing and retired templates', async () => {
    await rejectWithoutPublication(
      { targetRegionId: regionId, template: 'missing@1' },
      'template_not_found',
    );

    await db
      .updateTable('templates')
      .set({ retired_at: new Date() })
      .where('name', '=', 'baseline')
      .execute();
    await rejectWithoutPublication(
      { targetRegionId: regionId, template: 'baseline@1' },
      'template_retired',
    );
  });

  it('rejects missing and retired component definitions', async () => {
    await registrations.registerTemplate(
      templateDocument('missing-component', {
        initialTopology: {
          instances: [{ name: 'missing', component: 'missing@1' }],
          connections: [],
        },
      }),
    );
    await rejectWithoutPublication(
      { targetRegionId: regionId, template: 'missing-component@1' },
      'component_definition_not_found',
    );

    await db
      .updateTable('component_definitions')
      .set({ retired_at: new Date() })
      .where('name', '=', 'producer')
      .execute();
    await rejectWithoutPublication(
      { targetRegionId: regionId, template: 'baseline@1' },
      'component_definition_retired',
    );
  });

  it('rejects missing and retired schemas', async () => {
    await registrations.registerTemplate(
      templateDocument('missing-schema', {
        inputs: [{ port: 'objective', schema: 'missing@1' }],
      }),
    );
    await rejectWithoutPublication(
      { targetRegionId: regionId, template: 'missing-schema@1' },
      'artifact_schema_not_found',
    );

    await db
      .updateTable('artifact_schemas')
      .set({ retired_at: new Date() })
      .where('name', '=', 'payload')
      .execute();
    await rejectWithoutPublication(
      { targetRegionId: regionId, template: 'baseline@1' },
      'artifact_schema_retired',
    );
  });

  it('rejects missing and retired policies', async () => {
    await registrations.registerTemplate(
      templateDocument('missing-policy', { policies: ['missing-policy@1'] }),
    );
    await rejectWithoutPublication(
      { targetRegionId: regionId, template: 'missing-policy@1' },
      'policy_not_found',
    );

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
    await rejectWithoutPublication(
      { targetRegionId: regionId, template: 'retired-policy-template@1' },
      'policy_retired',
    );
  });

  it('rejects missing and retired capabilities', async () => {
    await registrations.registerTemplate(
      templateDocument('missing-capability', {
        capabilities: ['missing-capability@1'],
      }),
    );
    await rejectWithoutPublication(
      { targetRegionId: regionId, template: 'missing-capability@1' },
      'capability_not_found',
    );

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
    await rejectWithoutPublication(
      {
        targetRegionId: regionId,
        template: 'retired-capability-template@1',
      },
      'capability_retired',
    );
  });

  it('rejects incompatible port schemas', async () => {
    await registrations.registerArtifactSchema(
      schemaDocument('alternate', { type: 'string' }),
    );
    await registrations.registerComponentDefinition(
      componentDocument('alternate-worker', 'input', 'alternate'),
    );
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
    await rejectWithoutPublication(
      { targetRegionId: regionId, template: 'incompatible@1' },
      'incompatible_port_schema',
    );
  });

  it('rejects invalid parameters and configuration', async () => {
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
    await rejectWithoutPublication(
      {
        targetRegionId: regionId,
        template: 'parameterized@1',
        parameters: { mode: 'unsupported' },
      },
      'invalid_template_parameters',
    );
    await rejectWithoutPublication(
      {
        targetRegionId: regionId,
        template: 'baseline@1',
        componentConfiguration: { missing: { attempts: 2 } },
      },
      'invalid_component_configuration',
    );
  });

  it('rejects an ineligible region', async () => {
    await db
      .updateTable('regions')
      .set({ lifecycle_status: 'running' })
      .where('id', '=', regionId)
      .execute();
    await rejectWithoutPublication(
      { targetRegionId: regionId, template: 'baseline@1' },
      'region_not_eligible',
    );
  });

  it('rolls back an activation failure without partial publication', async () => {
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
    await expectNoPublication(db);

    expect(
      await db
        .selectFrom('regions')
        .select(['active_topology_revision_id', 'lifecycle_status'])
        .where('id', '=', regionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      active_topology_revision_id: null,
      lifecycle_status: 'ready',
    });
  });
});
