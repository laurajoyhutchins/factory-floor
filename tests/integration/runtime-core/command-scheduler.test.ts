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
const databaseName = `ff_scheduler_${randomUUID().replaceAll('-', '')}`;
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

describe('durable command routing and scheduler concurrency', () => {
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
      .query(`drop database if exists ${databaseName} with (force)`)
      .catch(() => undefined);
    await admin.end();
  });

  it('deduplicates concurrent command submission, event creation, and routing', async () => {
    const commands = new CommandService(db);
    const request = {
      region: '/investigation',
      commandType: 'investigation.start',
      source: { kind: 'user', subject: 'integration-test' },
      payload: { objective: 'compare the evidence' },
      correlationId: 'investigation-correlation',
      idempotencyKey: 'same-request',
    } as const;

    const results = await Promise.all([
      commands.submit(request),
      commands.submit(request),
    ]);

    expect(results.map((result) => result.disposition).sort()).toEqual([
      'accepted',
      'replayed',
    ]);
    expect(new Set(results.map((result) => result.commandId)).size).toBe(1);
    expect(new Set(results.map((result) => result.eventId)).size).toBe(1);
    expect(new Set(results.flatMap((result) => result.deliveryIds)).size).toBe(2);
    expect(await db.selectFrom('commands').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('events').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('deliveries').selectAll().execute()).toHaveLength(
      2,
    );
  });

  it('allows only one competing poller to lease a complete multi-input group', async () => {
    const commands = new CommandService(db);
    await commands.submit({
      region: '/investigation',
      commandType: 'investigation.start',
      source: { kind: 'user', subject: 'integration-test' },
      payload: { objective: 'compare the evidence' },
      correlationId: 'scheduler-correlation',
      idempotencyKey: 'scheduler-request',
    });

    const scheduler = new SchedulerService(db);
    const results = await Promise.all([
      scheduler.pollForExecution({ owner: 'worker-a', leaseDurationMs: 30_000 }),
      scheduler.pollForExecution({ owner: 'worker-b', leaseDurationMs: 30_000 }),
    ]);

    const scheduled = results.filter((result) => result !== null);
    expect(scheduled).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(scheduled[0]?.inputs).toHaveLength(2);
    expect(await db.selectFrom('executions').selectAll().execute()).toHaveLength(
      1,
    );
    expect(
      await db.selectFrom('execution_attempts').selectAll().execute(),
    ).toHaveLength(1);
    expect(
      await db.selectFrom('execution_inputs').selectAll().execute(),
    ).toHaveLength(2);
    const deliveries = await db.selectFrom('deliveries').selectAll().execute();
    expect(deliveries).toHaveLength(2);
    expect(
      deliveries.every(
        (delivery) =>
          delivery.status === 'leased' &&
          delivery.attempts_count === 1 &&
          delivery.lease_token !== null,
      ),
    ).toBe(true);
    expect(new Set(deliveries.map((delivery) => delivery.lease_token)).size).toBe(
      1,
    );
  });

  it('durably rejects an already expired command without creating deliveries', async () => {
    const commands = new CommandService(
      db,
      undefined,
      undefined,
      () => new Date('2026-07-15T05:00:00.000Z'),
    );
    const result = await commands.submit({
      region: '/investigation',
      commandType: 'investigation.start',
      source: { kind: 'user', subject: 'integration-test' },
      payload: { objective: 'too late' },
      idempotencyKey: 'expired-request',
      expiresAt: '2026-07-15T04:59:59.000Z',
    });

    expect(result).toMatchObject({
      disposition: 'rejected',
      status: 'rejected',
      deliveryIds: [],
      rejection: { code: 'command_expired' },
    });
    expect(await db.selectFrom('commands').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('events').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('deliveries').selectAll().execute()).toEqual([]);
  });
});
