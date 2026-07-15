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
const databaseName = `ff_worker_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);
const digest = createHash('sha256').update('data').digest('hex');

interface SeededRuntime {
  readonly regionId: string;
}

async function seedRuntime(
  db: ReturnType<typeof createDatabase>,
): Promise<SeededRuntime> {
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
        name: 'objective',
        direction: 'input',
        schema_id: schemaId,
        required: true,
      },
      {
        id: createUuidV7(),
        component_definition_id: definitionId,
        name: 'result',
        direction: 'output',
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
  return { regionId };
}

function attemptIdentity(envelope: {
  executionId: string;
  attemptId: string;
  leaseToken: string;
  lifecycleEpoch: number;
}) {
  return {
    executionId: envelope.executionId,
    attemptId: envelope.attemptId,
    leaseToken: envelope.leaseToken,
    lifecycleEpoch: envelope.lifecycleEpoch,
  };
}

describe('worker protocol lifecycle and idempotency', () => {
  const db = createDatabase(testUrl);
  let seeded: SeededRuntime;
  let artifactRoot: string;
  let now: Date;
  let service: WorkerProtocolService;

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
    seeded = await seedRuntime(db);
    artifactRoot = await mkdtemp(join(tmpdir(), 'factory-floor-worker-'));
    now = new Date(Date.now() + 60_000);
    service = new WorkerProtocolService(
      db,
      new FilesystemArtifactBlobStore(artifactRoot),
      { leaseDurationMs: 60_000, baseUrl: 'http://127.0.0.1:3000' },
      () => new Date(now),
    );
  });

  afterEach(async () => {
    await rm(artifactRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName} with (force)`)
      .catch(() => undefined);
    await admin.end();
  });

  async function submitAndClaim(capabilities = ['retrieve@1']) {
    await new CommandService(db).submit({
      region: '/investigation',
      commandType: 'investigation.start',
      source: { kind: 'user', subject: 'worker-protocol-test' },
      payload: { objective: 'compare the evidence' },
      correlationId: 'worker-protocol-correlation',
      idempotencyKey: 'worker-protocol-command',
    });
    const claimed = await service.claim({ workerId: 'worker-a', capabilities });
    if (!claimed.claimed) throw new Error('expected a claimed attempt');
    return claimed.envelope;
  }

  it('does not lease work to a worker that lacks the component capability', async () => {
    await new CommandService(db).submit({
      region: '/investigation',
      commandType: 'investigation.start',
      source: { kind: 'user', subject: 'worker-protocol-test' },
      payload: { objective: 'compare the evidence' },
      correlationId: 'worker-capability-correlation',
      idempotencyKey: 'worker-capability-command',
    });

    await expect(
      service.claim({ workerId: 'python-worker', capabilities: ['verify@1'] }),
    ).resolves.toMatchObject({ claimed: false });
    await expect(
      service.claim({
        workerId: 'typescript-worker',
        capabilities: ['retrieve@1'],
      }),
    ).resolves.toMatchObject({ claimed: true });
  });

  it('extends a heartbeat atomically and fences the current region epoch', async () => {
    const envelope = await submitAndClaim();
    now = new Date(now.getTime() + 20_000);
    const expectedLeaseExpiresAt = new Date(
      now.getTime() + 60_000,
    ).toISOString();

    await expect(
      service.heartbeat(attemptIdentity(envelope)),
    ).resolves.toMatchObject({
      leaseValid: true,
      leaseExpiresAt: expectedLeaseExpiresAt,
    });
    await db
      .updateTable('regions')
      .set({ lifecycle_epoch: envelope.lifecycleEpoch + 1 })
      .where('id', '=', seeded.regionId)
      .execute();

    await expect(
      service.heartbeat(attemptIdentity(envelope)),
    ).rejects.toMatchObject({
      code: 'stale_lifecycle_epoch',
    });
  });

  it('reports cancellation after lifecycle fencing instead of relying on process state', async () => {
    const envelope = await submitAndClaim();
    await db
      .updateTable('regions')
      .set({
        lifecycle_status: 'cancelling',
        lifecycle_epoch: envelope.lifecycleEpoch + 1,
      })
      .where('id', '=', seeded.regionId)
      .execute();

    await expect(
      service.cancellation(attemptIdentity(envelope)),
    ).resolves.toEqual({
      protocolVersion: '1.0',
      state: 'cancellation_requested',
    });
  });

  it('persists stage authority before upload and rejects an arbitrary staged reference', async () => {
    const envelope = await submitAndClaim();
    const identity = attemptIdentity(envelope);
    const staged = await service.stage({
      ...identity,
      portName: 'result',
      mediaType: 'application/json',
      expectedDigest: digest,
      expectedSizeBytes: 4,
      metadata: { purpose: 'test' },
    });

    expect(
      await db
        .selectFrom('worker_artifact_uploads')
        .selectAll()
        .where('staged_ref', '=', staged.stagedRef)
        .executeTakeFirst(),
    ).toMatchObject({
      attempt_id: envelope.attemptId,
      port_name: 'result',
      expected_digest: digest,
      expected_size_bytes: '4',
    });
    await expect(
      service.upload(
        createUuidV7(),
        identity,
        Readable.from(Buffer.from('data')),
      ),
    ).rejects.toMatchObject({ code: 'unauthorized_staging_reference' });
  });

  it('uploads authorized bytes idempotently and records immutable staging metadata', async () => {
    const envelope = await submitAndClaim();
    const identity = attemptIdentity(envelope);
    const staged = await service.stage({
      ...identity,
      portName: 'result',
      mediaType: 'application/json',
      expectedDigest: digest,
      expectedSizeBytes: 4,
      metadata: { purpose: 'test' },
    });

    const first = await service.upload(
      staged.stagedRef,
      identity,
      Readable.from(Buffer.from('data')),
    );
    const second = await service.upload(
      staged.stagedRef,
      identity,
      Readable.from(Buffer.from('data')),
    );

    expect(second).toEqual(first);
    expect(
      await db
        .selectFrom('artifact_staging')
        .selectAll()
        .where('attempt_id', '=', envelope.attemptId)
        .where('staged_ref', '=', staged.stagedRef)
        .execute(),
    ).toHaveLength(1);
  });

  it('records concurrent identical results once and rejects a conflicting retry', async () => {
    const envelope = await submitAndClaim();
    const result = {
      protocolVersion: '1.0' as const,
      ...attemptIdentity(envelope),
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

    const responses = await Promise.all([
      service.submitResult(result),
      service.submitResult({ ...result }),
    ]);
    expect(responses.map((response) => response.duplicate).sort()).toEqual([
      false,
      true,
    ]);
    expect(
      await db.selectFrom('worker_result_submissions').selectAll().execute(),
    ).toHaveLength(1);

    await expect(
      service.submitResult({ ...result, status: 'cancelled' }),
    ).rejects.toBeInstanceOf(WorkerProtocolError);
    await expect(
      service.submitResult({ ...result, status: 'cancelled' }),
    ).rejects.toMatchObject({ code: 'duplicate_conflicting_result' });
  });
});
