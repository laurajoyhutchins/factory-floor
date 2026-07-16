import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  migrateToLatest,
  resetDatabaseForDevelopment,
} from '../../../packages/db/src/index.js';
import {
  ObservabilityService,
  RegistrationService,
  SystemApplicationService,
} from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_registration_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

const schemaDocument = {
  apiVersion: 'factoryfloor.dev/v1alpha1',
  kind: 'ArtifactSchema',
  metadata: { name: 'payload', version: '1' },
  spec: { schema: { type: 'object', additionalProperties: true } },
};

function componentDocument(
  name: string,
  ports: Array<{
    name: string;
    direction: 'input' | 'output';
    required: boolean;
  }>,
) {
  return {
    apiVersion: 'factoryfloor.dev/v1alpha1',
    kind: 'ComponentDefinition',
    metadata: { name, version: '1' },
    spec: {
      ports: ports.map((port) => ({
        ...port,
        schema: { name: 'payload', version: '1' },
      })),
    },
  };
}

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

const systemDocument = {
  apiVersion: 'factoryfloor.dev/v1alpha1',
  kind: 'System',
  metadata: { name: 'investigation-demo', version: '1' },
  spec: {
    rootRegion: { id: 'investigation-root' },
    regions: [
      { id: 'intake', template: 'request-intake@1' },
      { id: 'investigation', template: 'bounded-investigation@1' },
      { id: 'publication', template: 'controlled-publication@1' },
    ],
    connections: [],
  },
};

describe('registration and static system application', () => {
  const db = createDatabase(testUrl);
  const registrations = new RegistrationService(db);
  const systems = new SystemApplicationService(db);

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
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('applies a registered static topology once and treats the same apply as a no-op', async () => {
    await registrations.registerArtifactSchema(schemaDocument);
    await registrations.registerComponentDefinition(
      componentDocument('retrieve', [
        { name: 'objective', direction: 'input', required: true },
        { name: 'evidence', direction: 'output', required: true },
      ]),
    );
    await registrations.registerComponentDefinition(
      componentDocument('verify', [
        { name: 'evidence', direction: 'input', required: true },
        { name: 'result', direction: 'output', required: true },
      ]),
    );
    await registrations.registerTemplate(templateDocument);

    const first = await systems.apply(systemDocument);
    const second = await systems.apply(systemDocument);

    expect(first.disposition).toBe('created');
    expect(second).toMatchObject({
      disposition: 'existing',
      digest: first.digest,
    });
    expect(await db.selectFrom('regions').selectAll().execute()).toHaveLength(
      4,
    );
    expect(
      await db.selectFrom('topology_revisions').selectAll().execute(),
    ).toHaveLength(1);
    expect(
      await db.selectFrom('component_instances').selectAll().execute(),
    ).toHaveLength(2);
    expect(
      await db.selectFrom('connections').selectAll().execute(),
    ).toHaveLength(1);

    const investigation = await db
      .selectFrom('regions')
      .select(['id', 'active_topology_revision_id'])
      .where('name', '=', 'investigation')
      .executeTakeFirstOrThrow();
    expect(investigation.active_topology_revision_id).not.toBeNull();

    const topology = await new ObservabilityService(db).activeTopology();
    expect(topology.regions.map((region) => region.name)).toContain(
      'investigation',
    );
    expect(topology.components.map((component) => component.name)).toEqual([
      'retrieve',
      'verify',
    ]);
    expect(topology.connections).toEqual([
      expect.objectContaining({
        sourcePortName: 'evidence',
        targetPortName: 'evidence',
      }),
    ]);
    expect(topology.components[0].ports.map((port) => port.name)).toContain(
      'objective',
    );
  });

  it('rejects invalid declarations before writing anything', async () => {
    expect(() =>
      registrations.registerArtifactSchema({
        ...schemaDocument,
        spec: { schema: { type: 42 } },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_declaration' }));

    expect(
      await db.selectFrom('artifact_schemas').selectAll().execute(),
    ).toEqual([]);
  });

  it('returns the existing registration for identical content and rejects conflicting content', async () => {
    const first = await registrations.registerArtifactSchema(schemaDocument);
    const second = await registrations.registerArtifactSchema({
      spec: schemaDocument.spec,
      metadata: schemaDocument.metadata,
      kind: schemaDocument.kind,
      apiVersion: schemaDocument.apiVersion,
    });

    expect(first.disposition).toBe('created');
    expect(second).toMatchObject({
      disposition: 'existing',
      digest: first.digest,
    });

    await expect(
      registrations.registerArtifactSchema({
        ...schemaDocument,
        spec: { schema: { type: 'string' } },
      }),
    ).rejects.toMatchObject({ code: 'registration_conflict' });
    expect(
      await db.selectFrom('artifact_schemas').selectAll().execute(),
    ).toHaveLength(1);
  });
});
