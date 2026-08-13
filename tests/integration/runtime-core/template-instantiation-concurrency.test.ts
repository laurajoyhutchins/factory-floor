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
        completedSteps: {
          type: 'array',
          items: { type: 'string' },
        },
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
      properties: {
        mode: {
          type: 'string',
          enum: ['strict', 'fast'],
        },
      },
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
      connections: [
        {
          from: 'producer.value',
          to: 'worker.value',
        },
      ],
      ingress: {
        commands: {
          'child.start': {
            targets: [
              {
                component: 'worker',
                port: 'value',
              },
            ],
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
  const payloads = await db
    .selectFrom('artifact_inline_payloads')
    .selectAll()
    .execute();
  const stateVersions = await db
    .selectFrom('component_state_versions')
    .selectAll()
    .execute();
  const stateLinks = await db
    .selectFrom('template_instantiation_state_links')
    .selectAll()
    .execute();

  expect(revisions).toEqual([]);
  expect(instances).toEqual([]);
  expect(connections).toEqual([]);
  expect(history).toEqual([]);
  expect(artifacts).toEqual([]);
  expect(payloads).toEqual([]);
  expect(stateVersions).toEqual([]);
  expect(stateLinks).toEqual([]);
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
        `PostgreSQL integration database is required at ` +
          `TEST_DATABASE_URL=${base}. Cause: ${String(error)}`,
      );
    }
  });

  beforeEach(async () => {
    const reset = await resetDatabaseForDevelopment(db, 'test');
    expect(reset.error).toBeUndefined();
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

  it('converges identical concurrent requests', async () => {
    const service = new TemplateInstantiationService(db);
    const request = {
      requestId: identicalRequestId,
      targetRegionId: regionId,
      template: 'concurrent-child@1',
      parameters: { mode: 'strict' },
      source: {
        kind: 'test',
        operation: 'identical-concurrency',
      },
    } as const;

    const results = await Promise.all([
      service.instantiate(request),
      service.instantiate(request),
    ]);

    const dispositions = results.map((result) => result.disposition).sort();
    expect(dispositions).toEqual(['created', 'existing']);
    expect(new Set(results.map((result) => result.instantiationId)).size).toBe(
      1,
    );
    expect(new Set(results.map((result) => result.digest)).size).toBe(1);
    expect(new Set(results.map((result) => result.revision.id)).size).toBe(1);

    const revisions = await db
      .selectFrom('topology_revisions')
      .selectAll()
      .execute();
    const instances = await db
      .selectFrom('component_instances')
      .selectAll()
      .execute();
    const connections = await db
      .selectFrom('connections')
      .selectAll()
      .execute();
    const history = await db
      .selectFrom('template_instantiations')
      .selectAll()
      .execute();
    const states = await db
      .selectFrom('component_state_versions')
      .selectAll()
      .execute();

    expect(revisions).toHaveLength(1);
    expect(instances).toHaveLength(2);
    expect(connections).toHaveLength(1);
    expect(history).toHaveLength(1);
    expect(states).toHaveLength(1);

    const restartedDb = createDatabase(testUrl);
    try {
      const restarted = new TemplateInstantiationService(restartedDb);
      const replay = await restarted.instantiate(request);
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

  it('returns one winner and one stable conflict', async () => {
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

    const fulfilled = [];
    const rejected = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        fulfilled.push(result.value);
      } else {
        rejected.push(result.reason);
      }
    }

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      code: 'template_instantiation_conflict',
    });
    expect(String(rejected[0])).not.toContain('23505');

    const revisions = await db
      .selectFrom('topology_revisions')
      .selectAll()
      .execute();
    const instances = await db
      .selectFrom('component_instances')
      .selectAll()
      .execute();
    const connections = await db
      .selectFrom('connections')
      .selectAll()
      .execute();
    const history = await db
      .selectFrom('template_instantiations')
      .selectAll()
      .execute();
    const states = await db
      .selectFrom('component_state_versions')
      .selectAll()
      .execute();

    expect(revisions).toHaveLength(1);
    expect(instances).toHaveLength(2);
    expect(connections).toHaveLength(1);
    expect(history).toHaveLength(1);
    expect(states).toHaveLength(1);
  });

  it('rolls back every durable write after a late failure', async () => {
    const rollbackRegion = await topology.createRegion(
      db,
      'rollback-region',
      null,
    );
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
    const region = await db
      .selectFrom('regions')
      .select(['active_topology_revision_id', 'lifecycle_status'])
      .where('id', '=', rollbackRegion.id)
      .executeTakeFirstOrThrow();
    expect(region).toEqual({
      active_topology_revision_id: null,
      lifecycle_status: 'ready',
    });
  });

  it('lets a child region use the generic runtime boundaries', async () => {
    const parent = await topology.createRegion(db, 'parent', null);
    const child = await topology.createRegion(db, 'child', parent.id);
    const service = new TemplateInstantiationService(db);
    const instantiated = await service.instantiate({
      targetRegionId: child.id,
      template: 'concurrent-child@1',
      parameters: { mode: 'fast' },
      source: { kind: 'child-region-adapter-test' },
    });

    const commandService = new CommandService(db);
    const command = await commandService.submit({
      region: '/parent/child',
      commandType: 'child.start',
      source: {
        kind: 'user',
        subject: 'child-region-contract-test',
      },
      payload: {
        objective: 'exercise the generic child boundary',
      },
      idempotencyKey: 'child-region-command',
    });

    expect(instantiated.disposition).toBe('created');
    expect(command).toMatchObject({
      disposition: 'accepted',
      status: 'accepted',
    });
    expect(command.deliveryIds).toHaveLength(1);

    const delivery = await db
      .selectFrom('deliveries')
      .select([
        'region_id',
        'topology_revision_id',
        'target_component_instance_id',
      ])
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
    expect(target).toEqual({
      name: 'worker',
      region_id: child.id,
    });
  });
});
