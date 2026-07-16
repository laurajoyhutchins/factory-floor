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
  ExecutionCommitService,
  ObservabilityService,
  PROJECTION_NAMES,
  SchedulerService,
  StartupRecoveryService,
} from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_recovery_${randomUUID().replaceAll('-', '')}`;
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
    .values({
      id: createUuidV7(),
      component_definition_id: definitionId,
      name: 'objective',
      direction: 'input',
      schema_id: schemaId,
      required: true,
    })
    .execute();
  await db
    .insertInto('regions')
    .values({
      id: regionId,
      name: 'investigation',
      lifecycle_status: 'running',
      lifecycle_epoch: 0,
    })
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
              targets: [{ component: 'retrieve', port: 'objective' }],
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
    .set({ active_topology_revision_id: topologyId })
    .where('id', '=', regionId)
    .execute();
  return { regionId };
}

async function createAttempt(db: ReturnType<typeof createDatabase>) {
  const command = await new CommandService(db).submit({
    region: '/investigation',
    commandType: 'investigation.start',
    source: { kind: 'integration-test' },
    payload: { objective: 'recover durable work' },
    correlationId: createUuidV7(),
    idempotencyKey: createUuidV7(),
  });
  expect(command.disposition).toBe('accepted');
  const schedulerClock = new Date(Date.now() + 5_000);
  const scheduled = await new SchedulerService(
    db,
    () => schedulerClock,
  ).pollForExecution({
    owner: 'recovery-test-worker',
    leaseDurationMs: 30_000,
  });
  expect(scheduled).not.toBeNull();
  return { scheduled: scheduled!, schedulerClock };
}

describe('observability replay and startup recovery', () => {
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

  it('rebuilds every projection from history without dispatch side effects', async () => {
    await new CommandService(db).submit({
      region: '/investigation',
      commandType: 'investigation.start',
      source: { kind: 'integration-test' },
      payload: { objective: 'inspect history' },
      correlationId: createUuidV7(),
      idempotencyKey: createUuidV7(),
    });
    const before = {
      deliveries: await db
        .selectFrom('deliveries')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow(),
      executions: await db
        .selectFrom('executions')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow(),
      actions: await db
        .selectFrom('external_actions')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow(),
    };

    const observability = new ObservabilityService(db);
    const first = await observability.rebuildProjections(1);
    const second = await observability.rebuildProjections(1);
    const status = await observability.projectionStatus();

    expect(first.processedEvents).toBeGreaterThan(0);
    expect(second.processedEvents).toBe(first.processedEvents);
    expect(status).toHaveLength(PROJECTION_NAMES.length);
    expect(status.every((item) => item.lastEventId !== null)).toBe(true);
    expect(
      await db.selectFrom('projection_checkpoints').selectAll().execute(),
    ).toHaveLength(PROJECTION_NAMES.length);
    expect(
      await db
        .selectFrom('deliveries')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow(),
    ).toEqual(before.deliveries);
    expect(
      await db
        .selectFrom('executions')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow(),
    ).toEqual(before.executions);
    expect(
      await db
        .selectFrom('external_actions')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow(),
    ).toEqual(before.actions);
  });

  it('recovers an expired attempt exactly once across repeated restarts', async () => {
    const { scheduled, schedulerClock } = await createAttempt(db);
    const now = new Date(schedulerClock.getTime() + 60_000);
    const recovery = new StartupRecoveryService(db, { clock: () => now });

    const first = await recovery.run({ now, projectionBatchSize: 1 });
    const second = await recovery.run({ now, projectionBatchSize: 1 });

    expect(first.expiredAttemptsAbandoned).toBe(1);
    expect(first.replacementAttemptsCreated).toBe(1);
    expect(first.retryableDeliveriesExposed).toBe(1);
    expect(second.expiredAttemptsAbandoned).toBe(0);
    expect(second.replacementAttemptsCreated).toBe(0);
    const attempts = await db
      .selectFrom('execution_attempts')
      .select(['attempt_number', 'status'])
      .where('execution_id', '=', scheduled.executionId)
      .orderBy('attempt_number')
      .execute();
    expect(attempts).toEqual([
      { attempt_number: 1, status: 'abandoned' },
      { attempt_number: 2, status: 'pending' },
    ]);
    const delivery = await db
      .selectFrom('deliveries')
      .select(['status', 'lease_token', 'lease_owner', 'lease_expires_at'])
      .where('id', '=', scheduled.inputs[0].deliveryId)
      .executeTakeFirstOrThrow();
    expect(delivery).toEqual({
      status: 'ready',
      lease_token: null,
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(
      await db
        .selectFrom('events')
        .selectAll()
        .where('event_type', '=', 'runtime.recovery.completed')
        .execute(),
    ).toHaveLength(2);
  });

  it('settles cancellation once and rejects a result from the stale epoch', async () => {
    const { scheduled, schedulerClock } = await createAttempt(db);
    const now = new Date(schedulerClock.getTime() + 1_000);
    await db
      .updateTable('regions')
      .set({ lifecycle_status: 'cancelling' })
      .where('name', '=', 'investigation')
      .execute();
    const recovery = new StartupRecoveryService(db, { clock: () => now });

    const first = await recovery.run({ now });
    const second = await recovery.run({ now });

    expect(first.cancellingRegionsSettled).toBe(1);
    expect(first.cancelledAttemptsSettled).toBe(1);
    expect(first.cancelledDeliveriesSettled).toBe(1);
    expect(second.cancellingRegionsSettled).toBe(0);
    const region = await db
      .selectFrom('regions')
      .select(['lifecycle_status', 'lifecycle_epoch'])
      .where('name', '=', 'investigation')
      .executeTakeFirstOrThrow();
    expect(region).toEqual({
      lifecycle_status: 'cancelled',
      lifecycle_epoch: 1,
    });
    expect(
      await db
        .selectFrom('execution_attempts')
        .select('status')
        .where('id', '=', scheduled.attemptId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'cancelled' });
    expect(
      await db
        .selectFrom('deliveries')
        .select('status')
        .where('id', '=', scheduled.inputs[0].deliveryId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'cancelled' });

    const commit = new ExecutionCommitService(db, undefined, () => now);
    await expect(
      commit.commit({
        protocolVersion: '1.0',
        executionId: scheduled.executionId,
        attemptId: scheduled.attemptId,
        leaseToken: scheduled.leaseToken,
        lifecycleEpoch: 0,
        status: 'completed',
        stagedArtifacts: [],
        proposedEvents: [],
        externalActionProposals: [],
        resourceUsage: {
          cpuMilliseconds: 0,
          wallMilliseconds: 0,
          inputBytes: 0,
          outputBytes: 0,
          externalCalls: 0,
        },
      }),
    ).rejects.toMatchObject({ code: 'inactive_attempt' });
    expect(
      await db
        .selectFrom('execution_outputs')
        .selectAll()
        .where('execution_id', '=', scheduled.executionId)
        .execute(),
    ).toHaveLength(0);
  });
});
