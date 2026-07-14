import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  migrateDown,
  migrateToLatest,
  resetDatabaseForDevelopment,
} from '../../../packages/db/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
async function canConnect(connectionString: string): Promise<boolean> {
  const probe = new pg.Pool({ connectionString, connectionTimeoutMillis: 250 });
  try {
    await probe.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}

const databaseAvailable = await canConnect(base);
const describeIfDatabase = databaseAvailable ? describe : describe.skip;
const admin = new pg.Pool({ connectionString: base });
const dbName = `ff_test_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);

async function q(sql: string) {
  await admin.query(sql);
}

describeIfDatabase('runtime database migration', () => {
  const db = createDatabase(testUrl);
  beforeAll(async () => {
    await q(`create database ${dbName}`);
  });
  afterAll(async () => {
    await db.destroy();
    await q(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  });

  it('creates the durable runtime schema with critical constraints and can roll back', async () => {
    const migrated = await migrateToLatest(db);
    expect(migrated.error).toBeUndefined();
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

    const schema = await db
      .insertInto('artifact_schemas')
      .values({
        name: 'objective',
        version: '1.0.0',
        content_digest: 'a'.repeat(64),
        schema: { type: 'object' },
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await expect(
      db
        .insertInto('artifacts')
        .values({
          digest_algorithm: 'sha256',
          digest: 'not-a-digest',
          size_bytes: '1',
          schema_id: schema.id,
          state: 'committed',
          media_type: 'application/json',
          committed_locator: 'sha256/x',
          provenance: {},
        })
        .execute(),
    ).rejects.toThrow();
    const region = await db
      .insertInto('regions')
      .values({ name: 'root' })
      .returningAll()
      .executeTakeFirstOrThrow();
    const topo = await db
      .insertInto('topology_revisions')
      .values({
        region_id: region.id,
        revision_number: 1,
        content_digest: 'b'.repeat(64),
        topology: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const def = await db
      .insertInto('component_definitions')
      .values({
        name: 'worker',
        version: '1.0.0',
        content_digest: 'c'.repeat(64),
        definition: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const inst = await db
      .insertInto('component_instances')
      .values({
        region_id: region.id,
        topology_revision_id: topo.id,
        component_definition_id: def.id,
        name: 'w',
        configuration: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const command = await db
      .insertInto('commands')
      .values({ region_id: region.id, command_type: 'start', payload: {} })
      .returningAll()
      .executeTakeFirstOrThrow();
    await expect(
      db
        .insertInto('deliveries')
        .values({
          region_id: region.id,
          topology_revision_id: topo.id,
          target_component_instance_id: inst.id,
          target_port_name: 'in',
        })
        .execute(),
    ).rejects.toThrow();
    await db
      .insertInto('deliveries')
      .values({
        region_id: region.id,
        topology_revision_id: topo.id,
        target_component_instance_id: inst.id,
        target_port_name: 'in',
        source_command_id: command.id,
      })
      .execute();

    const delivery = await db
      .selectFrom('deliveries')
      .selectAll()
      .executeTakeFirstOrThrow();
    const execution = await db
      .insertInto('executions')
      .values({
        delivery_id: delivery.id,
        region_id: region.id,
        component_instance_id: inst.id,
        topology_revision_id: topo.id,
        lifecycle_epoch: 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('execution_attempts')
      .values({ execution_id: execution.id, attempt_number: 1 })
      .execute();
    await expect(
      db
        .insertInto('execution_attempts')
        .values({ execution_id: execution.id, attempt_number: 1 })
        .execute(),
    ).rejects.toThrow();

    const down = await migrateDown(db);
    expect(down.error).toBeUndefined();
    const remaining = await db
      .selectFrom('information_schema.tables')
      .select('table_name')
      .where('table_schema', '=', 'public')
      .execute();
    expect(remaining.map((t) => t.table_name)).not.toContain('deliveries');
  });

  it('deterministically recreates a clean development database', async () => {
    const reset = await resetDatabaseForDevelopment(db, 'test');
    expect(reset.error).toBeUndefined();
    await db.insertInto('regions').values({ name: 'transient' }).execute();
    await resetDatabaseForDevelopment(db, 'test');
    expect(await db.selectFrom('regions').selectAll().execute()).toEqual([]);
    await expect(resetDatabaseForDevelopment(db, 'production')).rejects.toThrow(
      /restricted/,
    );
  });
});
