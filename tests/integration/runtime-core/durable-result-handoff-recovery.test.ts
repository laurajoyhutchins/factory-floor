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
  OperatorCommandService,
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
const databaseName = `ff_result_handoff_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);
const operator = {
  principal: { id: 'result-handoff-operator', roles: ['operator'] },
  adapter: 'integration-test',
};

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
      name: 'durable-result-objective',
      version: '1',
      content_digest: 'a'.repeat(64),
      schema: { type: 'object' },
    })
    .execute();
  await db
    .insertInto('component_definitions')
    .values({
      id: definitionId,
      name: 'durable-result-worker',
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
      name: 'durable-result-region',
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
            'durable-result.start': {
              targets: [{ component: 'durable-result-worker', port: 'objective' }],
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
      name: 'durable-result-worker',
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

async function submitAndClaim(
  db: ReturnType<typeof createDatabase>,
  workers: WorkerProtocolService,
) {
  const command = await new CommandService(db).submit({
    region: '/durable-result-region',
    commandType: 'durable-result.start',
    source: { kind: 'integration-test' },
    payload: { objective: 'recover the durable handoff' },
    correlationId: createUuidV7(),
    idempotencyKey: createUuidV7(),
  });
  const claim = await workers.claim({
    workerId: 'durable-result-worker',
    capabilities: ['durable-result-worker@1'],
  });
  if (!claim.claimed) throw new Error('expected a claimed execution attempt');
  return { runId: command.commandId, envelope: claim.envelope };
}

function completedResult(envelope: {
  executionId: string;
  attemptId: string;
  leaseToken: string;
  lifecycleEpoch: number;
}) {
  return {
    protocolVersion: '1.0' as const,
    executionId: envelope.executionId,
    attemptId: envelope.attemptId,
    leaseToken: envelope.leaseToken,
    lifecycleEpoch: envelope.lifecycleEpoch,
    status: 'completed' as const,
    stagedArtifacts: [],
    proposedEvents: [],
    externalActionProposals: [],
    resourceUsage: {
      cpuMilliseconds: 1,
      wallMilliseconds: 2,
      inputBytes: 3,
      outputBytes: 4,
      externalCalls: 0,
    },
  };
}

describe('durable worker-result handoff recovery', () => {
  const db = createDatabase(testUrl);
  let now = new Date();

  beforeAll(async () => {
    await admin.query(`create database ${databaseName}`);
    expect((await migrateToLatest(db)).error).toBeUndefined();
  });

  beforeEach(async () => {
    expect(
      (await resetDatabaseForDevelopment(db, 'test')).error,
    ).toBeUndefined();
    await seedRuntime(db);
    now = new Date(Date.now() + 60_000);
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('commits a persisted handoff once after restart even after lease expiry', async () => {
    const workers = new WorkerProtocolService(
      db,
      undefined,
      {
        leaseDurationMs: 60_000,
        afterResultHandoffCommitted: async () => {
          throw new Error('simulated control-plane stop after durable handoff');
        },
      },
      () => new Date(now),
    );
    const { envelope } = await submitAndClaim(db, workers);

    await expect(
      workers.submitResult(completedResult(envelope)),
    ).rejects.toThrow('simulated control-plane stop after durable handoff');
    await expect(
      db
        .selectFrom('worker_result_submissions')
        .select(['attempt_id', 'committed_at'])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ attempt_id: envelope.attemptId, committed_at: null });
    await expect(
      db.selectFrom('resource_ledger').selectAll().execute(),
    ).resolves.toHaveLength(0);

    now = new Date(now.getTime() + 120_000);
    const first = await new StartupRecoveryService(db, {
      clock: () => new Date(now),
    }).run({ now: new Date(now), resultCommitBatchSize: 10 });
    const second = await new StartupRecoveryService(db, {
      clock: () => new Date(now),
    }).run({ now: new Date(now), resultCommitBatchSize: 10 });

    expect(first.submittedResultsScanned).toBe(1);
    expect(first.submittedResultsCommitted).toBe(1);
    expect(first.submittedResultsRejected).toBe(0);
    expect(first.expiredAttemptsAbandoned).toBe(0);
    expect(second.submittedResultsScanned).toBe(0);
    await expect(
      db
        .selectFrom('worker_result_submissions')
        .select('committed_at')
        .where('attempt_id', '=', envelope.attemptId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ committed_at: expect.any(Date) });
    await expect(
      db
        .selectFrom('execution_attempts')
        .select('status')
        .where('id', '=', envelope.attemptId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'completed' });
    await expect(
      db
        .selectFrom('executions')
        .select('status')
        .where('id', '=', envelope.executionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'completed' });
    await expect(
      db
        .selectFrom('deliveries')
        .select('status')
        .where('id', '=', envelope.inputs[0]!.deliveryId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'completed' });
    await expect(
      db.selectFrom('resource_ledger').selectAll().execute(),
    ).resolves.toHaveLength(4);
  });

  it('rejects a handed-off result when operator cancellation wins before commit', async () => {
    let markHandoff!: () => void;
    let releaseCommit!: () => void;
    const handoffPersisted = new Promise<void>((resolve) => {
      markHandoff = resolve;
    });
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const workers = new WorkerProtocolService(
      db,
      undefined,
      {
        leaseDurationMs: 60_000,
        afterResultHandoffCommitted: async () => {
          markHandoff();
          await commitReleased;
        },
      },
      () => new Date(now),
    );
    const { runId, envelope } = await submitAndClaim(db, workers);
    const submission = workers.submitResult(completedResult(envelope));
    await handoffPersisted;

    await new OperatorCommandService(db).cancelRun(operator, runId, {
      clientRequestId: createUuidV7(),
      reason: 'Cancellation must win before authoritative publication.',
    });
    releaseCommit();

    await expect(submission).rejects.toMatchObject({ code: 'inactive_attempt' });
    await expect(
      db.selectFrom('worker_result_submissions').selectAll().execute(),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .selectFrom('execution_attempts')
        .select('status')
        .where('id', '=', envelope.attemptId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'cancelled' });
    await expect(
      db
        .selectFrom('executions')
        .select(['status', 'failure'])
        .where('id', '=', envelope.executionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'operator_cancelled' },
    });
    await expect(
      db
        .selectFrom('deliveries')
        .select('status')
        .where('id', '=', envelope.inputs[0]!.deliveryId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'cancelled' });
    await expect(
      db.selectFrom('execution_outputs').selectAll().execute(),
    ).resolves.toHaveLength(0);
    await expect(
      db.selectFrom('resource_ledger').selectAll().execute(),
    ).resolves.toHaveLength(0);
  });
});
