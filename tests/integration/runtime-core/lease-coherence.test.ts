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
  StartupRecoveryService,
  WorkerProtocolService,
} from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_lease_coherence_${randomUUID().replaceAll('-', '')}`;
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
    .set({
      active_topology_revision_id: topologyId,
      lifecycle_status: 'running',
    })
    .where('id', '=', regionId)
    .execute();
}

describe('attempt and delivery lease coherence', () => {
  const db = createDatabase(testUrl);
  let now: Date;

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
    now = new Date('2026-07-16T00:00:00.000Z');
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('renews input deliveries atomically and recovery preserves the live lease', async () => {
    await new CommandService(db).submit({
      region: '/investigation',
      commandType: 'investigation.start',
      source: { kind: 'user', subject: 'lease-test' },
      payload: { objective: 'test lease renewal' },
      correlationId: 'lease-coherence',
      idempotencyKey: 'lease-coherence',
    });
    const workers = new WorkerProtocolService(
      db,
      undefined,
      { leaseDurationMs: 60_000, baseUrl: 'http://127.0.0.1:3000' },
      () => new Date(now),
    );
    const claimed = await workers.claim({
      workerId: 'worker-a',
      capabilities: ['retrieve@1'],
    });
    if (!claimed.claimed) throw new Error('expected work');
    const originalExpiry = claimed.envelope.leaseExpiresAt;

    now = new Date('2026-07-16T00:00:20.000Z');
    const heartbeat = await workers.heartbeat({
      executionId: claimed.envelope.executionId,
      attemptId: claimed.envelope.attemptId,
      leaseToken: claimed.envelope.leaseToken,
      lifecycleEpoch: claimed.envelope.lifecycleEpoch,
    });
    expect(heartbeat.leaseExpiresAt).not.toBe(originalExpiry);

    const deliveryAfterHeartbeat = await db
      .selectFrom('deliveries')
      .select(['status', 'lease_token', 'lease_expires_at'])
      .where('correlation_id', '=', 'lease-coherence')
      .executeTakeFirstOrThrow();
    expect(deliveryAfterHeartbeat).toMatchObject({
      status: 'leased',
      lease_token: claimed.envelope.leaseToken,
      lease_expires_at: new Date(heartbeat.leaseExpiresAt),
    });

    now = new Date('2026-07-16T00:01:10.000Z');
    await new StartupRecoveryService(db, { clock: () => new Date(now) }).run({
      projectionBatchSize: 50,
      reconciliationBatchSize: 50,
    });

    expect(
      await db
        .selectFrom('execution_attempts')
        .select(['status', 'lease_expires_at'])
        .where('id', '=', claimed.envelope.attemptId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      status: 'running',
      lease_expires_at: new Date(heartbeat.leaseExpiresAt),
    });
    expect(
      await db
        .selectFrom('deliveries')
        .select(['status', 'lease_token', 'lease_expires_at'])
        .where('correlation_id', '=', 'lease-coherence')
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      status: 'leased',
      lease_token: claimed.envelope.leaseToken,
      lease_expires_at: new Date(heartbeat.leaseExpiresAt),
    });
  });
});
