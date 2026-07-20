import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createUuidV7,
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
const databaseName = `ff_template_inspection_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

const requestA = '019bb22e-58b0-7d87-8000-000000000401';
const requestB = '019bb22e-58b0-7d87-8000-000000000402';
const requestC = '019bb22e-58b0-7d87-8000-000000000403';
const requestD = '019bb22e-58b0-7d87-8000-000000000404';
const source = { kind: 'internal', operation: 'inspection-test' } as const;

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
            value: {
              completedSteps: { $parameter: 'completedSteps' },
            },
          },
        },
      ],
      connections: [],
    },
  },
};

describe('template-instantiation operator inspection in PostgreSQL', () => {
  const db = createDatabase(testUrl);
  const registrations = new RegistrationService(db);
  const topology = new TopologyRepository();
  const runtime = new RuntimeRepository();
  let regionA: { id: string; name: string };
  let regionB: { id: string; name: string };

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
    regionA = await topology.createRegion(db, 'inspection-a', null);
    regionB = await topology.createRegion(db, 'inspection-b', null);
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  async function instantiateFixture() {
    const instantiations = new TemplateInstantiationService(db);
    const parameters = { completedSteps: ['fetch', 'compare'] };
    const first = await instantiations.instantiate({
      requestId: requestA,
      targetRegionId: regionA.id,
      template: 'seeded@1',
      parameters,
      source,
    });
    const second = await instantiations.instantiate({
      requestId: requestB,
      targetRegionId: regionA.id,
      template: 'seeded@1',
      parameters,
      source,
    });
    const third = await instantiations.instantiate({
      requestId: requestC,
      targetRegionId: regionA.id,
      template: 'seeded@1',
      parameters,
      source,
    });
    const otherRegion = await instantiations.instantiate({
      requestId: requestD,
      targetRegionId: regionB.id,
      template: 'seeded@1',
      parameters,
      source,
    });
    const component = await db
      .selectFrom('component_instances')
      .selectAll()
      .where('topology_revision_id', '=', first.revision.id)
      .where('name', '=', 'verifier')
      .executeTakeFirstOrThrow();
    const command = await runtime.createCommand(db, {
      regionId: regionA.id,
      commandType: 'inspection-run',
      payload: {},
    });
    const delivery = await runtime.createCommandDelivery(db, {
      regionId: regionA.id,
      topologyRevisionId: first.revision.id,
      targetComponentInstanceId: component.id,
      targetPortName: 'checkpoint',
      commandId: command.id,
    });
    const lifecycle = await db
      .selectFrom('regions')
      .select('lifecycle_epoch')
      .where('id', '=', regionA.id)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('executions')
      .values({
        id: createUuidV7(),
        delivery_id: delivery.id,
        region_id: regionA.id,
        component_instance_id: component.id,
        topology_revision_id: first.revision.id,
        lifecycle_epoch: lifecycle.lifecycle_epoch,
        input_set_digest: 'e'.repeat(64),
        completed_at: null,
        failed_at: null,
        failure: null,
      })
      .execute();
    return { first, second, third, otherRegion, component, command };
  }

  it('returns complete region-scoped history with deterministic scope-bound pagination', async () => {
    const fixture = await instantiateFixture();
    const service = new TemplateInstantiationInspectionService(db);

    const firstPage = await service.list(
      { regionId: regionA.id },
      { limit: 2 },
    );
    expect(firstPage.items.map((item) => item.id)).toEqual([
      fixture.first.instantiationId,
      fixture.second.instantiationId,
    ]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await service.list(
      { regionId: regionA.id },
      { cursor: firstPage.nextCursor!, limit: 2 },
    );
    expect(secondPage.items.map((item) => item.id)).toEqual([
      fixture.third.instantiationId,
    ]);
    expect(secondPage.nextCursor).toBeNull();

    await expect(
      service.list(
        { regionId: regionB.id },
        { cursor: firstPage.nextCursor!, limit: 2 },
      ),
    ).rejects.toThrow('invalid_cursor');

    const detail = await service.get(fixture.second.instantiationId);
    expect(detail).toMatchObject({
      id: fixture.second.instantiationId,
      requestId: requestB,
      requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      effectiveDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      disposition: 'existing',
      targetRegion: { id: regionA.id, name: regionA.name },
      topologyRevision: {
        id: fixture.first.revision.id,
        revisionNumber: 1,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      template: {
        id: expect.any(String),
        name: 'seeded',
        version: '1',
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      parameters: { completedSteps: ['fetch', 'compare'] },
      componentConfiguration: {},
      source,
      referencedDefinitions: expect.any(Array),
      initialStates: [
        {
          versionNumber: 1,
          owner: {
            componentInstanceId: fixture.component.id,
            componentName: 'verifier',
            portName: 'checkpoint',
          },
          schema: {
            id: expect.any(String),
            name: 'checkpoint',
            version: '1',
            digest: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
          artifact: {
            id: expect.any(String),
            digestAlgorithm: 'sha256',
            digest: expect.stringMatching(/^[0-9a-f]{64}$/),
            mediaType: 'application/json',
            state: 'committed',
          },
          value: { completedSteps: ['fetch', 'compare'] },
          source: {
            kind: 'templateInstantiation',
            instantiationId: fixture.first.instantiationId,
          },
          provenance: expect.any(Object),
        },
      ],
      createdAt: expect.any(Date),
    });
    expect(detail?.initialStates[0]?.artifact).not.toHaveProperty(
      'committedLocator',
    );
    expect(await service.get(randomUUID())).toBeNull();
  });

  it('isolates run-scoped history and preserves relationships after service reconstruction', async () => {
    const fixture = await instantiateFixture();
    const service = new TemplateInstantiationInspectionService(db);

    const runHistory = await service.list(
      { runId: fixture.command.id },
      { limit: 10 },
    );
    expect(runHistory.items.map((item) => item.id)).toEqual([
      fixture.first.instantiationId,
      fixture.second.instantiationId,
      fixture.third.instantiationId,
    ]);
    expect(runHistory.items).not.toContainEqual(
      expect.objectContaining({ id: fixture.otherRegion.instantiationId }),
    );

    const topologyHistory = await service.listForTopologyRevision(
      fixture.first.revision.id,
    );
    expect(topologyHistory.map((item) => item.id)).toEqual(
      runHistory.items.map((item) => item.id),
    );

    const detail = await service.get(fixture.first.instantiationId);
    const artifactId = detail!.initialStates[0]!.artifact.id;
    const artifactHistory = await new TemplateInstantiationInspectionService(
      db,
    ).forArtifact(artifactId);
    expect(artifactHistory.map((item) => item.id)).toEqual([
      fixture.first.instantiationId,
      fixture.second.instantiationId,
      fixture.third.instantiationId,
      fixture.otherRegion.instantiationId,
    ]);
  });

  it('rejects unscoped, ambiguous, and invalid page requests', async () => {
    const service = new TemplateInstantiationInspectionService(db);
    await expect(service.list({}, {})).rejects.toThrow('invalid_scope');
    await expect(
      service.list({ regionId: regionA.id, runId: randomUUID() }, {}),
    ).rejects.toThrow('invalid_scope');
    await expect(
      service.list({ regionId: regionA.id }, { limit: 0 }),
    ).rejects.toThrow('invalid_limit');
    await expect(
      service.list({ regionId: regionA.id }, { cursor: 'not-a-cursor' }),
    ).rejects.toThrow('invalid_cursor');
  });
});
