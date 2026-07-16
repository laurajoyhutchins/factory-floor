import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createUuidV7,
  migrateToLatest,
  resetDatabaseForDevelopment,
} from '../../../packages/db/src/index.js';
import {
  CommandService,
  SchedulerService,
} from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_scheduler_fair_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

async function seedRuntime(db: ReturnType<typeof createDatabase>) {
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
      version: '1',
      content_digest: 'a'.repeat(64),
      schema: { type: 'object' },
    })
    .execute();
  await db
    .insertInto('component_definitions')
    .values({
      id: definitionId,
      name: 'retrieve',
      version: '1',
      content_digest: 'b'.repeat(64),
      definition: {},
    })
    .execute();
  await db
    .insertInto('port_definitions')
    .values([
      {
        id: createUuidV7(),
        component_definition_id: definitionId,
        name: 'context',
        direction: 'input',
        schema_id: schemaId,
        required: true,
      },
      {
        id: createUuidV7(),
        component_definition_id: definitionId,
        name: 'objective',
        direction: 'input',
        schema_id: schemaId,
        required: true,
      },
    ])
    .execute();
  await db
    .insertInto('regions')
    .values({ id: regionId, name: 'investigation' })
    .execute();
  await db
    .insertInto('topology_revisions')
    .values({
      id: topologyId,
      region_id: regionId,
      revision_number: 1,
      content_digest: 'c'.repeat(64),
      topology: {
        ingress: {
          commands: {
            'investigation.start': {
              targets: [
                { component: 'retrieve', port: 'context' },
                { component: 'retrieve', port: 'objective' },
              ],
            },
          },
        },
      },
      activated_at: new Date(),
    })
    .execute();
  await db
    .insertInto('component_instances')
    .values({
      id: instanceId,
      region_id: regionId,
      topology_revision_id: topologyId,
      component_definition_id: definitionId,
      name: 'retrieve',
      configuration: {},
      lifecycle_status: 'ready',
    })
    .execute();
  await db
    .updateTable('regions')
    .set({
      active_topology_revision_id: topologyId,
      lifecycle_status: 'running',
    })
    .where('id', '=', regionId)
    .execute();
}

describe('scheduler fairness', () => {
  const db = createDatabase(testUrl);

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
    await seedRuntime(db);
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('continues past an older incomplete group to lease a complete group', async () => {
    const commands = new CommandService(db);
    await commands.submit({
      region: '/investigation',
      commandType: 'investigation.start',
      source: { kind: 'user', subject: 'integration-test' },
      payload: { objective: 'old incomplete work' },
      correlationId: 'older-incomplete',
      idempotencyKey: 'older-incomplete',
    });
    await commands.submit({
      region: '/investigation',
      commandType: 'investigation.start',
      source: { kind: 'user', subject: 'integration-test' },
      payload: { objective: 'new complete work' },
      correlationId: 'newer-complete',
      idempotencyKey: 'newer-complete',
    });

    const older = await db
      .selectFrom('deliveries')
      .select(['id', 'target_port_name'])
      .where('correlation_id', '=', 'older-incomplete')
      .orderBy('target_port_name')
      .execute();
    await db
      .deleteFrom('deliveries')
      .where('id', '=', older.find((row) => row.target_port_name === 'context')!.id)
      .execute();
    await db
      .updateTable('deliveries')
      .set({ available_at: new Date('2026-07-16T00:00:00.000Z') })
      .where('correlation_id', '=', 'older-incomplete')
      .execute();
    await db
      .updateTable('deliveries')
      .set({ available_at: new Date('2026-07-16T00:00:01.000Z') })
      .where('correlation_id', '=', 'newer-complete')
      .execute();

    const scheduled = await new SchedulerService(
      db,
      () => new Date('2026-07-16T00:01:00.000Z'),
    ).pollForExecution({ owner: 'worker-a', leaseDurationMs: 30_000 });

    expect(scheduled).not.toBeNull();
    const leasedCorrelations = await db
      .selectFrom('deliveries')
      .select('correlation_id')
      .where('id', 'in', scheduled!.inputs.map((input) => input.deliveryId))
      .execute();
    expect(new Set(leasedCorrelations.map((row) => row.correlation_id))).toEqual(
      new Set(['newer-complete']),
    );
    expect(
      await db
        .selectFrom('deliveries')
        .select('status')
        .where('correlation_id', '=', 'older-incomplete')
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ status: 'ready' });
  });
});
