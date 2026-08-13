import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactRepository,
  ComponentStateRepository,
  createDatabase,
  DefinitionRepository,
  migrateToLatest,
  resetDatabaseForDevelopment,
  type RuntimeDb,
  TemplateInstantiationRepository,
  TopologyRepository,
} from '../../../packages/db/src/index.js';
import {
  CommandService,
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
const databaseName = `ff_template_concurrency_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

const identicalRequestId = '019bb22e-58b0-7d87-8000-000000000401';
const conflictingRequestId = '019bb22e-58b0-7d87-8000-000000000402';
const rollbackRequestId = '019bb22e-58b0-7d87-8000-000000000403';

const payloadSchema = {
  apiVersion: 'factory-floor.dev/v1alpha1',
  kind: 'ArtifactSchema',
  metadata: { name: 'payload', version: '1' },
  spec: { schema: { type: 'object', additionalProperties: true } },
};

const checkpointSchema = {
  apiVersion: 'factory-floor.dev/v1alpha1',
  kind: 'ArtifactSchema',
  metadata: { name: 'checkpoint', version: '1' },
  spec: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['completedSteps'],
      properties: {
        completedSteps: { type: 'array', items: { type: 'string' } },
      },
    },
  },
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
      {
        name: 'checkpoint',
        direction: 'state',
        required: false,
        schema: { name: 'checkpoint', version: '1' },
      },
    ],
  },
};

const templateDocument = {
  apiVersion: 'factory-floor.dev/v1alpha1',
  kind: 'Template',
  metadata: { name: 'concurrent-child', version: '1' },
  spec: {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: { mode: { type: 'string', enum: ['strict', 'fast'] } },
    },
    initialTopology: {
      instances: [
        { name: 'producer', component: 'producer@1' },
        {
          name: 'worker',
          component: 'worker@1',
          configuration: { mode: { $parameter: 'mode' } },
          initialState: {
            port: 'checkpoint',
            value: { completedSteps: [] },
          },
        },
      ],
      connections: [{ from: 'producer.value', to: 'worker.value' }],
      ingress: {
        commands: {
          'child.start': {
            targets: [{ component: 'worker', port: 'value' }],
          },
        },
      },
    },
  },
};

class FailAfterStateLinkRepository extends ComponentStateRepository {
  override async linkInstantiationIdempotently(
    db: RuntimeDb,
    templateInstantiationId: string,
    stateVersionId: string,
  ) {
    await super.linkInstantiationIdempotently(
      db,
      templateInstantiationId,
      stateVersionId,
    );
    throw new Error('injected failure after state link publication');
  }
}

async function registerFixture(registrations: RegistrationService) {
  await registrations.registerArtifactSchema(payloadSchema);
  await registrations.registerArtifactSchema(checkpointSchema);
  await registrations.registerComponentDefinition(producerDefinition);
  await registrations.registerComponentDefinition(workerDefinition);
  await registrations.registerTemplate(templateDocument);
}

async function expectNoPublishedInstantiation(db: ReturnType<typeof createDatabase>) {
  expect(await db.selectFrom('topology_revisions').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('component_instances').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('connections').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('template_instantiations').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('artifacts').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('artifact_inline_payloads').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('component_state_versions').selectAll().execute()).toEqual([]);
  expect(
    await db.selectFrom('template_instantiation_state_links').selectAll().execute(),
  ).toEqual([]);
}

describe('PostgreSQL template instantiation concurrency', () => {
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
        `PostgreSQL integration database is required at TEST_DATABASE_URL=${base}. Cause: ${String(error)}`,
      );
    }
  });

  beforeEach(async () => {
    expect((await resetDatabaseForDevelopment(db, 'test')).error).toBeUndefined();
    await registerFixture(registrations);
    regionId = (await topology.createRegion(db, 'concurrent-region', null)).id;
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('converges identical concurrent requests on one durable topology and survives a fresh database connection', async () => {
    const service = new TemplateInstantiationService(db);
    const request = {
      requestId: identicalRequestId,
      targetRegionId: regionId,
      template: 'concurrent-child@1',
      parameters: { mode: 'strict' },
      source: { kind: 'test', operation: 'identical-concurrency' },
    } as const;

    const results = await Promise.all([
      service.instantiate(request),
      service.instantiate(request),
    ]);

    expect(results.map((result) => result.disposition).sort()).toEqual([
      'created',
      'existing',
    ]);
    expect(new Set(results.map((result) => result.instantiationId)).size).toBe(1);
    expect(new Set(results.map((result) => result.digest)).size).toBe(1);
    expect(new Set(results.map((result) => result.revision.id)).size).toBe(1);
    expect(await db.selectFrom('topology_revisions').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('component_instances').selectAll().execute()).toHaveLength(2);
    expect(await db.selectFrom('connections').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('template_instantiations').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('component_state_versions').selectAll().execute()).toHaveLength(1);

    const restartedDb = createDatabase(testUrl);
    try {
      const replay = await new TemplateInstantiationService(restartedDb).instantiate(request);
      expect(replay).toMatchObject({
        disposition: 'existing',
        instantiationId: results[0]!.instantiationId,
        digest: results[0]!.digest,
      });
      expect(replay.revision.id).toBe(results[0]!.revision.id);
    } finally {
      await restartedDb.destroy();
    }
  });

  it('makes one conflicting concurrent request authoritative and returns a stable domain conflict for the loser', async () => {
    const service = new TemplateInstantiationService(db);
    const common = {
      requestId: conflictingRequestId,
      targetRegionId: regionId,
      template: 'concurrent-child@1',
      parameters: { mode: 'strict' },
    } as const;

    const results = await Promise.allSettled([
      service.instantiate({
        ...common,
        source: { kind: 'test', candidate: 'alpha' },
      }),
      service.instantiate({
        ...common,
        source: { kind: 'test', candidate: 'beta' },
      }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.instantiate>>> =>
        result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({
      code: 'template_instantiation_conflict',
    });
    expect(String(rejected[0]!.reason)).not.toContain('23505');
    expect(await db.selectFrom('topology_revisions').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('component_instances').selectAll().execute()).toHaveLength(2);
    expect(await db.selectFrom('connections').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('template_instantiations').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('component_state_versions').selectAll().execute()).toHaveLength(1);
  });

  it('rolls back revision, instances, connection, history, artifact, inline payload, state version, and state link after a late failure', async () => {
    const rollbackRegion = await topology.createRegion(db, 'rollback-region', null);
    const service = new TemplateInstantiationService(
      db,
      new DefinitionRepository(),
      new TopologyRepository(),
      new TemplateInstantiationRepository(),
      new ArtifactRepository(),
      new FailAfterStateLinkRepository(),
    );

    await expect(
      service.instantiate({
        requestId: rollbackRequestId,
        targetRegionId: rollbackRegion.id,
        template: 'concurrent-child@1',
        parameters: { mode: 'strict' },
      }),
    ).rejects.toThrow('injected failure after state link publication');

    await expectNoPublishedInstantiation(db);
    expect(
      await db
        .selectFrom('regions')
        .select(['active_topology_revision_id', 'lifecycle_status'])
        .where('id', '=', rollbackRegion.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      active_topology_revision_id: null,
      lifecycle_status: 'ready',
    });
  });

  it('lets a minimal child-region consumer use the public instantiation and command boundaries unchanged', async () => {
    const parent = await topology.createRegion(db, 'parent', null);
    const child = await topology.createRegion(db, 'child', parent.id);
    const instantiated = await new TemplateInstantiationService(db).instantiate({
      targetRegionId: child.id,
      template: 'concurrent-child@1',
      parameters: { mode: 'fast' },
      source: { kind: 'child-region-adapter-test' },
    });

    const command = await new CommandService(db).submit({
      region: '/parent/child',
      commandType: 'child.start',
      source: { kind: 'user', subject: 'child-region-contract-test' },
      payload: { objective: 'exercise the generic child boundary' },
      idempotencyKey: 'child-region-command',
    });

    expect(instantiated.disposition).toBe('created');
    expect(command).toMatchObject({ disposition: 'accepted', status: 'accepted' });
    expect(command.deliveryIds).toHaveLength(1);
    const delivery = await db
      .selectFrom('deliveries')
      .select(['region_id', 'topology_revision_id', 'target_component_instance_id'])
      .where('id', '=', command.deliveryIds[0]!)
      .executeTakeFirstOrThrow();
    expect(delivery).toMatchObject({
      region_id: child.id,
      topology_revision_id: instantiated.revision.id,
    });
    const target = await db
      .selectFrom('component_instances')
      .select(['name', 'region_id'])
      .where('id', '=', delivery.target_component_instance_id)
      .executeTakeFirstOrThrow();
    expect(target).toEqual({ name: 'worker', region_id: child.id });
  });
});
