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
  WorkerProtocolService,
} from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_result_contention_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

async function seedRuntime(db: ReturnType<typeof createDatabase>) {
  const schemaId = createUuidV7();
  const definitionId = createUuidV7();
  const regionId = createUuidV7();
  const topologyId = createUuidV7();

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
      name: 'worker',
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
      name: 'contention',
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
            start: { targets: [{ component: 'worker', port: 'objective' }] },
          },
        },
      },
      activated_at: new Date(),
    })
    .execute();
  await db
    .insertInto('component_instances')
    .values({
      id: createUuidV7(),
      region_id: regionId,
      topology_revision_id: topologyId,
      component_definition_id: definitionId,
      name: 'worker',
      configuration: {},
      lifecycle_status: 'ready',
    })
    .execute();
  await db
    .updateTable('regions')
    .set({ active_topology_revision_id: topologyId })
    .where('id', '=', regionId)
    .execute();
}

describe('result submission contention', () => {
  const db = createDatabase(testUrl);
  const now = new Date('2026-07-17T00:00:00.000Z');
  const service = new WorkerProtocolService(
    db,
    undefined,
    { leaseDurationMs: 60_000, baseUrl: 'http://127.0.0.1:3000' },
    () => now,
  );

  beforeAll(async () => {
    await admin.query(`create database ${databaseName}`);
    expect((await migrateToLatest(db)).error).toBeUndefined();
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

  async function claim() {
    await new CommandService(db).submit({
      region: '/contention',
      commandType: 'start',
      source: { kind: 'result-contention-test' },
      payload: { objective: true },
      idempotencyKey: randomUUID(),
    });
    const claimed = await service.claim({
      workerId: 'worker-a',
      capabilities: ['worker@1'],
    });
    if (!claimed.claimed) throw new Error('expected work');
    return claimed.envelope;
  }

  function result(
    env: Awaited<ReturnType<typeof claim>>,
    wallMilliseconds: number,
  ) {
    return {
      protocolVersion: '1.0' as const,
      executionId: env.executionId,
      attemptId: env.attemptId,
      leaseToken: env.leaseToken,
      lifecycleEpoch: env.lifecycleEpoch,
      status: 'completed' as const,
      stagedArtifacts: [],
      proposedEvents: [],
      externalActionProposals: [],
      resourceUsage: {
        cpuMilliseconds: 1,
        wallMilliseconds,
        inputBytes: 1,
        outputBytes: 1,
        externalCalls: 0,
      },
    };
  }

  it('converges concurrent identical submissions to one authoritative result', async () => {
    const env = await claim();
    const proposed = result(env, 2);

    const settled = await Promise.all(
      Array.from({ length: 8 }, () => service.submitResult(proposed)),
    );

    expect(settled).toHaveLength(8);
    expect(settled.filter((entry) => entry.duplicate)).toHaveLength(7);
    expect(settled.filter((entry) => !entry.duplicate)).toHaveLength(1);
    await expect(
      db
        .selectFrom('worker_result_submissions')
        .selectAll()
        .where('attempt_id', '=', env.attemptId)
        .execute(),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .selectFrom('executions')
        .select('status')
        .where('id', '=', env.executionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'completed' });
  });

  it('rejects conflicting submissions deterministically under contention', async () => {
    const env = await claim();
    const first = result(env, 2);
    const conflicting = result(env, 3);

    const settled = await Promise.allSettled([
      service.submitResult(first),
      service.submitResult(conflicting),
    ]);

    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((entry) => entry.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'duplicate_conflicting_result' },
    });
    await expect(
      db
        .selectFrom('worker_result_submissions')
        .selectAll()
        .where('attempt_id', '=', env.attemptId)
        .execute(),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .selectFrom('resource_ledger')
        .selectAll()
        .where('attempt_id', '=', env.attemptId)
        .execute(),
    ).resolves.toHaveLength(4);
  });
});
