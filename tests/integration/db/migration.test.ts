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
  connectionTimeoutMillis: 1_000,
});
const dbName = `ff_test_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);

async function q(sqlText: string) {
  await admin.query(sqlText);
}

async function seedGraph(db: ReturnType<typeof createDatabase>) {
  const schemaId = createUuidV7();
  const defId = createUuidV7();
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
      id: defId,
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
      component_definition_id: defId,
      name: 'w',
      configuration: {},
    })
    .execute();
  return { schemaId, defId, regionId, topologyId, instanceId };
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
    await q(`drop database if exists ${dbName} with (force)`).catch(
      () => undefined,
    );
    await admin.end();
  });

  it('creates the durable runtime schema with critical constraints and can roll back', async () => {
    expect((await migrateToLatest(db)).error).toBeUndefined();
    const tables = await db
      .selectFrom('information_schema.tables')
      .select('table_name')
      .where('table_schema', '=', 'public')
      .execute();
    expect(tables.map((t) => t.table_name).sort()).toEqual(
      expect.arrayContaining([
        'artifact_schemas',
        'deliveries',
        'execution_attempts',
        'artifacts',
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
    await expect(
      db
        .insertInto('artifacts')
        .values({
          id: createUuidV7(),
          digest_algorithm: 'sha256',
          digest: 'not-a-digest',
          size_bytes: '1',
          schema_id: ids.schemaId,
          state: 'committed',
          media_type: 'application/json',
          committed_locator: 'sha256/x',
          provenance: {},
        })
        .execute(),
    ).rejects.toThrow();

    const digest = 'e'.repeat(64);
    await db
      .insertInto('artifacts')
      .values({
        id: createUuidV7(),
        digest_algorithm: 'sha256',
        digest,
        size_bytes: '5',
        schema_id: ids.schemaId,
        state: 'committed',
        media_type: 'application/json',
        committed_locator: 'sha256/e',
        provenance: { source: 'test' },
      })
      .execute();
    await expect(
      db
        .insertInto('artifacts')
        .values({
          id: createUuidV7(),
          digest_algorithm: 'sha256',
          digest,
          size_bytes: '6',
          schema_id: ids.schemaId,
          state: 'committed',
          media_type: 'application/json',
          committed_locator: 'sha256/e2',
          provenance: { source: 'conflict' },
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
    await expect(
      db
        .insertInto('deliveries')
        .values({
          id: createUuidV7(),
          region_id: ids.regionId,
          topology_revision_id: ids.topologyId,
          target_component_instance_id: ids.instanceId,
          target_port_name: 'in',
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto('events')
        .values({
          id: createUuidV7(),
          region_id: ids.regionId,
          event_type: 'bad',
          payload: {},
          stream_key: 's',
          sequence_number: '1',
          source_kind: 'command',
        })
        .execute(),
    ).rejects.toThrow();

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
    await expect(
      db
        .insertInto('deliveries')
        .values({
          id: createUuidV7(),
          region_id: ids.regionId,
          topology_revision_id: ids.topologyId,
          target_component_instance_id: createUuidV7(),
          target_port_name: 'in',
          source_command_id: commandId,
        })
        .execute(),
    ).rejects.toThrow();

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
    const attempt1 = createUuidV7();
    await db
      .insertInto('execution_attempts')
      .values({ id: attempt1, execution_id: executionId, attempt_number: 1 })
      .execute();
    await expect(
      db
        .insertInto('execution_attempts')
        .values({
          id: createUuidV7(),
          execution_id: executionId,
          attempt_number: 1,
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto('execution_attempts')
        .values({
          id: createUuidV7(),
          execution_id: executionId,
          attempt_number: 2,
          status: 'leased',
        })
        .execute(),
    ).rejects.toThrow();

    const attempt2 = createUuidV7();
    await db
      .insertInto('execution_attempts')
      .values({ id: attempt2, execution_id: executionId, attempt_number: 2 })
      .execute();
    await db
      .insertInto('artifact_staging')
      .values({
        id: createUuidV7(),
        attempt_id: attempt1,
        staged_ref: 'same',
        digest_algorithm: 'sha256',
        digest: 'f'.repeat(64),
        size_bytes: '10',
        schema_id: ids.schemaId,
        media_type: 'application/json',
        locator: 'stage/1',
      })
      .execute();
    await db
      .insertInto('artifact_staging')
      .values({
        id: createUuidV7(),
        attempt_id: attempt2,
        staged_ref: 'same',
        digest_algorithm: 'sha256',
        digest: 'f'.repeat(64),
        size_bytes: '10',
        schema_id: ids.schemaId,
        media_type: 'application/json',
        locator: 'stage/2',
      })
      .execute();

    await expect(
      db
        .insertInto('resource_ledger')
        .values({
          id: createUuidV7(),
          region_id: ids.regionId,
          resource_type: 'tokens',
          quantity: '1.000000000001',
          unit: 'token',
          attributes: {},
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto('approvals')
        .values({
          id: createUuidV7(),
          policy_decision_id: createUuidV7(),
          status: 'approved',
        })
        .execute(),
    ).rejects.toThrow();

    expect((await migrateDown(db)).error).toBeUndefined();
    const remaining = await db
      .selectFrom('information_schema.tables')
      .select('table_name')
      .where('table_schema', '=', 'public')
      .execute();
    expect(remaining.map((t) => t.table_name)).not.toContain('deliveries');
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
      db.transaction().execute(async (trx) => {
        const schema = await definitions.createArtifactSchema(trx, {
          name: 'repo-schema',
          version: '1.0.0',
          contentDigest: '1'.repeat(64),
          schema: {},
        });
        await runtime.createRegion(trx, { name: 'repo-region' });
        expect(isUuidV7(schema.id)).toBe(true);
        await artifacts.createCommittedArtifact(trx, {
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
