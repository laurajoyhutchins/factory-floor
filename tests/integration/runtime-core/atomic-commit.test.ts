/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { FilesystemArtifactBlobStore } from '../../../packages/artifact-store/src/index.js';
import {
  createDatabase,
  createUuidV7,
  migrateToLatest,
  resetDatabaseForDevelopment,
} from '../../../packages/db/src/index.js';
import {
  CommandService,
  WorkerProtocolError,
  WorkerProtocolService,
} from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_atomic_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);
const schemaDoc = {
  type: 'object',
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
  additionalProperties: false,
};
const schemaDigest = 'a'.repeat(64);
const usage = {
  cpuMilliseconds: 1,
  wallMilliseconds: 2,
  inputBytes: 3,
  outputBytes: 4,
  externalCalls: 0,
};

async function seed(db: ReturnType<typeof createDatabase>) {
  const schemaId = createUuidV7();
  const producerDef = createUuidV7();
  const consumerDef = createUuidV7();
  const regionId = createUuidV7();
  const topologyId = createUuidV7();
  const producer = createUuidV7();
  const consumer = createUuidV7();
  await db
    .insertInto('artifact_schemas')
    .values({
      id: schemaId,
      name: 'payload',
      version: '1',
      content_digest: schemaDigest,
      schema: schemaDoc,
    })
    .execute();
  await db
    .insertInto('component_definitions')
    .values([
      {
        id: producerDef,
        name: 'producer',
        version: '1',
        content_digest: 'b'.repeat(64),
        definition: {},
      },
      {
        id: consumerDef,
        name: 'consumer',
        version: '1',
        content_digest: 'c'.repeat(64),
        definition: {},
      },
    ])
    .execute();
  await db
    .insertInto('port_definitions')
    .values([
      {
        id: createUuidV7(),
        component_definition_id: producerDef,
        name: 'in',
        direction: 'input',
        schema_id: schemaId,
        required: true,
      },
      {
        id: createUuidV7(),
        component_definition_id: producerDef,
        name: 'out',
        direction: 'output',
        schema_id: schemaId,
        required: true,
      },
      {
        id: createUuidV7(),
        component_definition_id: consumerDef,
        name: 'in',
        direction: 'input',
        schema_id: schemaId,
        required: true,
      },
    ])
    .execute();
  await db.insertInto('regions').values({ id: regionId, name: 'investigation' }).execute();
  await db
    .insertInto('topology_revisions')
    .values({
      id: topologyId,
      region_id: regionId,
      revision_number: 1,
      content_digest: 'd'.repeat(64),
      topology: {
        ingress: {
          commands: {
            start: { targets: [{ component: 'producer', port: 'in' }] },
          },
        },
      },
      activated_at: new Date(),
    })
    .execute();
  await db
    .insertInto('component_instances')
    .values([
      {
        id: producer,
        region_id: regionId,
        topology_revision_id: topologyId,
        component_definition_id: producerDef,
        name: 'producer',
        configuration: {},
        lifecycle_status: 'ready',
      },
      {
        id: consumer,
        region_id: regionId,
        topology_revision_id: topologyId,
        component_definition_id: consumerDef,
        name: 'consumer',
        configuration: {},
        lifecycle_status: 'ready',
      },
    ])
    .execute();
  await db
    .insertInto('connections')
    .values({
      id: createUuidV7(),
      topology_revision_id: topologyId,
      source_component_instance_id: producer,
      source_port_name: 'out',
      target_component_instance_id: consumer,
      target_port_name: 'in',
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
  return { schemaId };
}

describe('atomic execution commit and retry', () => {
  const db = createDatabase(testUrl);
  let root = '';
  let service: WorkerProtocolService;
  let blobStore: FilesystemArtifactBlobStore;
  let schemaId = '';
  let now = new Date();

  beforeAll(async () => {
    await admin.query(`create database ${databaseName}`);
    expect((await migrateToLatest(db)).error).toBeUndefined();
  });

  beforeEach(async () => {
    expect((await resetDatabaseForDevelopment(db, 'test')).error).toBeUndefined();
    ({ schemaId } = await seed(db));
    root = await mkdtemp(join(tmpdir(), 'ff-atomic-'));
    blobStore = new FilesystemArtifactBlobStore(root);
    now = new Date(Date.now() + 60_000);
    service = new WorkerProtocolService(
      db,
      blobStore,
      { leaseDurationMs: 60_000, baseUrl: 'http://127.0.0.1:3000' },
      () => now,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName} with (force)`)
      .catch(() => undefined);
    await admin.end();
  });

  async function claim() {
    await new CommandService(db).submit({
      region: '/investigation',
      commandType: 'start',
      source: { kind: 'test' },
      payload: { ok: true },
      idempotencyKey: randomUUID(),
    });
    const claimed = await service.claim({
      workerId: 'w',
      capabilities: ['producer@1'],
    });
    if (!claimed.claimed) throw new Error('no claim');
    return claimed.envelope;
  }

  async function stage(env: any, body = '{"ok":true}', portName = 'out') {
    const digest = createHash('sha256').update(body).digest('hex');
    const staged = await service.stage({
      executionId: env.executionId,
      attemptId: env.attemptId,
      leaseToken: env.leaseToken,
      lifecycleEpoch: env.lifecycleEpoch,
      portName,
      mediaType: 'application/json',
      expectedDigest: digest,
      expectedSizeBytes: Buffer.byteLength(body),
      metadata: {},
    });
    await service.upload(
      staged.stagedRef,
      {
        executionId: env.executionId,
        attemptId: env.attemptId,
        leaseToken: env.leaseToken,
        lifecycleEpoch: env.lifecycleEpoch,
      },
      Readable.from([body]),
    );
    return {
      stagingId: staged.stagedRef,
      portName,
      digest,
      sizeBytes: Buffer.byteLength(body),
      mediaType: 'application/json',
      schemaId,
      schemaDigest,
      provenance: {
        kind: 'execution',
        executionId: env.executionId,
        attemptId: env.attemptId,
      },
    };
  }

  function result(env: any, artifact: any, overrides: Record<string, unknown> = {}) {
    return {
      protocolVersion: '1.0',
      executionId: env.executionId,
      attemptId: env.attemptId,
      leaseToken: env.leaseToken,
      lifecycleEpoch: env.lifecycleEpoch,
      status: 'completed',
      stagedArtifacts: artifact ? [artifact] : [],
      proposedEvents: [],
      externalActionProposals: [],
      resourceUsage: usage,
      ...overrides,
    } as any;
  }

  it('publishes all successful effects and promotes the staged blob idempotently', async () => {
    const env = await claim();
    const artifact = await stage(env);
    const proposed = result(env, artifact);

    await expect(service.submitResult(proposed)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      handoff: 'committed_by_control_plane',
    });
    await expect(service.submitResult(proposed)).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
    });
    await expect(db.selectFrom('artifacts').selectAll().execute()).resolves.toHaveLength(1);
    await expect(db.selectFrom('execution_outputs').selectAll().execute()).resolves.toHaveLength(1);
    await expect(
      db
        .selectFrom('events')
        .selectAll()
        .where('source_attempt_id', '=', env.attemptId)
        .execute(),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .selectFrom('deliveries')
        .selectAll()
        .where('source_event_id', 'is not', null)
        .execute(),
    ).resolves.toHaveLength(1);
    await expect(db.selectFrom('resource_ledger').selectAll().execute()).resolves.toHaveLength(4);
    await expect(
      db
        .selectFrom('executions')
        .select('status')
        .where('id', '=', env.executionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: 'completed' });
    await expect(
      db
        .selectFrom('artifact_staging')
        .select(['status', 'artifact_id'])
        .where('staged_ref', '=', artifact.stagingId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: 'promoted' });
    await expect(blobStore.committedExists(artifact.digest)).resolves.toBe(true);
  });

  it('rolls back validation failures and permits a corrected result', async () => {
    const env = await claim();
    const invalid = await stage(env, '{"ok":"no"}');
    await expect(service.submitResult(result(env, invalid))).rejects.toBeInstanceOf(
      WorkerProtocolError,
    );
    await expect(db.selectFrom('artifacts').selectAll().execute()).resolves.toHaveLength(0);
    await expect(db.selectFrom('execution_outputs').selectAll().execute()).resolves.toHaveLength(0);
    await expect(db.selectFrom('resource_ledger').selectAll().execute()).resolves.toHaveLength(0);
    await expect(
      db.selectFrom('worker_result_submissions').selectAll().execute(),
    ).resolves.toHaveLength(0);

    const corrected = await stage(env);
    await expect(service.submitResult(result(env, corrected))).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
    });
  });

  it('preserves failed attempt history and staged partial artifacts before retry', async () => {
    const env = await claim();
    const partial = await stage(env);
    await expect(
      service.submitResult(
        result(env, partial, {
          status: 'failed',
          failure: {
            code: 'transient',
            message: 'try again',
            retryable: true,
          },
        }),
      ),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      db
        .selectFrom('execution_attempts')
        .selectAll()
        .where('execution_id', '=', env.executionId)
        .execute(),
    ).resolves.toHaveLength(2);
    await expect(db.selectFrom('artifacts').selectAll().execute()).resolves.toHaveLength(0);
    await expect(
      db
        .selectFrom('artifact_staging')
        .selectAll()
        .where('attempt_id', '=', env.attemptId)
        .execute(),
    ).resolves.toHaveLength(1);
    await expect(
      service.claim({ workerId: 'w2', capabilities: ['producer@1'] }),
    ).resolves.toMatchObject({ claimed: false });
    now = new Date(now.getTime() + 1_000);
    await expect(
      service.claim({ workerId: 'w2', capabilities: ['producer@1'] }),
    ).resolves.toMatchObject({ claimed: true });
  });

  it('rejects stale authority and undeclared output without partial effects', async () => {
    const env = await claim();
    const artifact = await stage(env);
    await expect(
      service.submitResult(result(env, artifact, { leaseToken: 'stale' })),
    ).rejects.toBeInstanceOf(WorkerProtocolError);
    await expect(db.selectFrom('artifacts').selectAll().execute()).resolves.toHaveLength(0);

    await db.updateTable('regions').set({ lifecycle_epoch: 1 }).execute();
    await expect(service.submitResult(result(env, artifact))).rejects.toBeInstanceOf(
      WorkerProtocolError,
    );
    await db.updateTable('regions').set({ lifecycle_epoch: 0 }).execute();

    await expect(
      service.submitResult(result(env, { ...artifact, portName: 'missing' })),
    ).rejects.toBeInstanceOf(WorkerProtocolError);
    await expect(db.selectFrom('artifacts').selectAll().execute()).resolves.toHaveLength(0);
    await expect(db.selectFrom('resource_ledger').selectAll().execute()).resolves.toHaveLength(0);
  });

  it('rejects external actions when the invocation issued no capability handles', async () => {
    const env = await claim();
    await expect(
      service.submitResult(
        result(env, undefined, {
          externalActionProposals: [
            {
              proposalId: createUuidV7(),
              actionType: 'demo.action',
              idempotencyKey: 'demo-action',
              capabilityHandle: 'not-issued',
              requestArtifact: {},
              risk: 'low',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(db.selectFrom('external_actions').selectAll().execute()).resolves.toHaveLength(0);
    await expect(db.selectFrom('resource_ledger').selectAll().execute()).resolves.toHaveLength(0);
  });
});
