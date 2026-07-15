import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ArtifactRepository,
  DefinitionRepository,
  RuntimeRepository,
  createDatabase,
  createUuidV7,
  isUuidV7,
  migrateDown,
  migrateToLatest,
  resetDatabaseForDevelopment,
} from '../../../packages/db/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const dbName = `ff_test_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);

async function q(sqlText: string) {
  await admin.query(sqlText);
}

async function migrateAllDown(db: ReturnType<typeof createDatabase>) {
  let result = await migrateDown(db);
  expect(result.error).toBeUndefined();
  while (result.results?.some((migration) => migration.status === 'Success')) {
    result = await migrateDown(db);
    expect(result.error).toBeUndefined();
  }
}

async function seedGraph(db: ReturnType<typeof createDatabase>) {
  const schemaId = createUuidV7();
  const definitionId = createUuidV7();
  const regionId = createUuidV7();
  const topologyId = createUuidV7();
  const instanceId = createUuidV7();

  await db
    .insertInto('artifact_schemas')
    .values({
      id: schemaId,
      name: 'objective',
      version: '1.0.0',
      content_digest: 'a'.repeat(64),
      schema: { type: 'object' },
    })
    .execute();
  await db
    .insertInto('component_definitions')
    .values({
      id: definitionId,
      name: 'worker',
      version: '1.0.0',
      content_digest: 'b'.repeat(64),
      definition: {},
    })
    .execute();
  await db
    .insertInto('regions')
    .values({ id: regionId, name: 'root' })
    .execute();
  await db
    .insertInto('topology_revisions')
    .values({
      id: topologyId,
      region_id: regionId,
      revision_number: 1,
      content_digest: 'c'.repeat(64),
      topology: {},
    })
    .execute();
  await db
    .insertInto('component_instances')
    .values({
      id: instanceId,
      region_id: regionId,
      topology_revision_id: topologyId,
      component_definition_id: definitionId,
      name: 'w',
      configuration: {},
    })
    .execute();

  return { schemaId, definitionId, regionId, topologyId, instanceId };
}

describe('runtime database migration', () => {
  const db = createDatabase(testUrl);

  beforeAll(async () => {
    try {
      await q(`create database ${dbName}`);
    } catch (error) {
      throw new Error(
        `PostgreSQL integration database is required at TEST_DATABASE_URL=${base}. Start the postgres service before running pnpm test:integration. Cause: ${String(error)}`,
      );
    }
  });

  afterAll(async () => {
    await db.destroy();
    await q(`drop database if exists ${dbName}`).catch(() => undefined);
    await admin.end();
  });

  it('applies every migration, enforces artifact reconciliation invariants, and rolls the complete stack back', async () => {
    expect((await migrateToLatest(db)).error).toBeUndefined();
    const tables = await db
      .selectFrom('information_schema.tables')
      .select('table_name')
      .where('table_schema', '=', 'public')
      .execute();
    expect(tables.map((table) => table.table_name)).toEqual(
      expect.arrayContaining([
        'artifact_schemas',
        'deliveries',
        'execution_attempts',
        'artifacts',
        'artifact_staging',
        'projection_checkpoints',
      ]),
    );

    const ids = await seedGraph(db);
    await expect(
      db
        .insertInto('regions')
        .values({ id: createUuidV7(), name: 'root' })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto('artifact_schemas')
        .values({
          id: randomUUID(),
          name: 'bad-id',
          version: '1',
          content_digest: 'd'.repeat(64),
          schema: {},
        })
        .execute(),
    ).rejects.toThrow();

    const commandId = createUuidV7();
    await db
      .insertInto('commands')
      .values({
        id: commandId,
        region_id: ids.regionId,
        command_type: 'start',
        payload: {},
      })
      .execute();
    const deliveryId = createUuidV7();
    await db
      .insertInto('deliveries')
      .values({
        id: deliveryId,
        region_id: ids.regionId,
        topology_revision_id: ids.topologyId,
        target_component_instance_id: ids.instanceId,
        target_port_name: 'in',
        source_command_id: commandId,
      })
      .execute();
    const executionId = createUuidV7();
    await db
      .insertInto('executions')
      .values({
        id: executionId,
        delivery_id: deliveryId,
        region_id: ids.regionId,
        component_instance_id: ids.instanceId,
        topology_revision_id: ids.topologyId,
        lifecycle_epoch: 0,
      })
      .execute();
    const attemptId = createUuidV7();
    await db
      .insertInto('execution_attempts')
      .values({ id: attemptId, execution_id: executionId, attempt_number: 1 })
      .execute();

    const stagingId = createUuidV7();
    await db
      .insertInto('artifact_staging')
      .values({
        id: stagingId,
        attempt_id: attemptId,
        staged_ref: 'result',
        digest_algorithm: 'sha256',
        digest: 'e'.repeat(64),
        size_bytes: '10',
        schema_id: ids.schemaId,
        media_type: 'application/json',
        locator: 'staging/result',
      })
      .execute();
    await expect(
      db
        .updateTable('artifact_staging')
        .set({ status: 'promoted', promoted_at: new Date() })
        .where('id', '=', stagingId)
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto('artifact_staging')
        .values({
          id: createUuidV7(),
          attempt_id: attemptId,
          staged_ref: 'duplicate-locator',
          digest_algorithm: 'sha256',
          digest: 'f'.repeat(64),
          size_bytes: '10',
          schema_id: ids.schemaId,
          media_type: 'application/json',
          locator: 'staging/result',
        })
        .execute(),
    ).rejects.toThrow();

    const artifactId = createUuidV7();
    await db
      .insertInto('artifacts')
      .values({
        id: artifactId,
        digest_algorithm: 'sha256',
        digest: 'e'.repeat(64),
        size_bytes: '10',
        schema_id: ids.schemaId,
        state: 'committed',
        media_type: 'application/json',
        committed_locator: `sha256:${'e'.repeat(64)}`,
        provenance: { source: 'integration-test' },
      })
      .execute();
    await db
      .updateTable('artifact_staging')
      .set({
        status: 'promoted',
        artifact_id: artifactId,
        promoted_at: new Date(),
      })
      .where('id', '=', stagingId)
      .execute();

    await migrateAllDown(db);
    const remaining = await db
      .selectFrom('information_schema.tables')
      .select('table_name')
      .where('table_schema', '=', 'public')
      .execute();
    expect(remaining.map((table) => table.table_name)).not.toContain(
      'deliveries',
    );
  });

  it('deterministically recreates a clean development database', async () => {
    expect(
      (await resetDatabaseForDevelopment(db, 'test')).error,
    ).toBeUndefined();
    await db
      .insertInto('regions')
      .values({ id: createUuidV7(), name: 'transient' })
      .execute();
    await resetDatabaseForDevelopment(db, 'test');
    expect(await db.selectFrom('regions').selectAll().execute()).toEqual([]);
    await expect(resetDatabaseForDevelopment(db, 'production')).rejects.toThrow(
      /restricted/,
    );
  });

  it('composes focused repositories in one transaction and rolls back on error', async () => {
    await resetDatabaseForDevelopment(db, 'test');
    const definitions = new DefinitionRepository();
    const runtime = new RuntimeRepository();
    const artifacts = new ArtifactRepository();

    await expect(
      db.transaction().execute(async (transaction) => {
        const schema = await definitions.createArtifactSchema(transaction, {
          name: 'repo-schema',
          version: '1.0.0',
          contentDigest: '1'.repeat(64),
          schema: {},
        });
        await runtime.createRegion(transaction, { name: 'repo-region' });
        expect(isUuidV7(schema.id)).toBe(true);
        await artifacts.createCommittedArtifact(transaction, {
          digest: '2'.repeat(64),
          sizeBytes: '42',
          schemaId: schema.id,
          mediaType: 'application/json',
          locator: 'sha256/2',
          provenance: { source: 'repo-test' },
        });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    expect(
      await db.selectFrom('artifact_schemas').selectAll().execute(),
    ).toEqual([]);
    expect(await db.selectFrom('regions').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('artifacts').selectAll().execute()).toEqual([]);
  });
});
