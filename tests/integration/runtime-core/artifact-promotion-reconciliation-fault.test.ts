import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FilesystemArtifactBlobStore,
  type ArtifactBlobStore,
} from '../../../packages/artifact-store/src/index.js';
import {
  ArtifactRepository,
  createDatabase,
  createUuidV7,
  migrateToLatest,
} from '../../../packages/db/src/index.js';
import {
  ArtifactPublicationService,
  ArtifactReconciliationService,
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
const databaseName = `ff_artifact_fault_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

function failFirstPromotion(delegate: ArtifactBlobStore): ArtifactBlobStore {
  let shouldFail = true;
  return {
    stage: delegate.stage.bind(delegate),
    readStaged: delegate.readStaged.bind(delegate),
    async promote(stagingId, digest, size) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('injected failure after metadata commit');
      }
      return delegate.promote(stagingId, digest, size);
    },
    readCommitted: delegate.readCommitted.bind(delegate),
    removeStaged: delegate.removeStaged.bind(delegate),
    stagedExists: delegate.stagedExists.bind(delegate),
    committedExists: delegate.committedExists.bind(delegate),
    listStaged: delegate.listStaged.bind(delegate),
  };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

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
      name: 'fault-payload',
      version: '1',
      content_digest: 'a'.repeat(64),
      schema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
        additionalProperties: false,
      },
    })
    .execute();
  await db
    .insertInto('component_definitions')
    .values({
      id: definitionId,
      name: 'producer',
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
        name: 'in',
        direction: 'input',
        schema_id: schemaId,
        required: true,
      },
      {
        id: createUuidV7(),
        component_definition_id: definitionId,
        name: 'out',
        direction: 'output',
        schema_id: schemaId,
        required: true,
      },
    ])
    .execute();
  await db
    .insertInto('regions')
    .values({ id: regionId, name: 'artifact-fault' })
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
            start: { targets: [{ component: 'producer', port: 'in' }] },
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
      name: 'producer',
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

  return { schemaId };
}

describe('artifact promotion reconciliation fault injection', () => {
  const db = createDatabase(testUrl);
  let artifactRoot = '';

  beforeAll(async () => {
    try {
      await admin.query(`create database ${databaseName}`);
      expect((await migrateToLatest(db)).error).toBeUndefined();
    } catch (error) {
      throw new Error(
        `PostgreSQL integration database is required at TEST_DATABASE_URL=${base}. Cause: ${String(error)}`,
      );
    }
    artifactRoot = await mkdtemp(join(tmpdir(), 'ff-artifact-fault-'));
  });

  afterAll(async () => {
    await rm(artifactRoot, { recursive: true, force: true });
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('converges metadata committed before promotion exactly once', async () => {
    const { schemaId } = await seedRuntime(db);
    const repository = new ArtifactRepository();
    const blobStore = new FilesystemArtifactBlobStore(artifactRoot);
    const worker = new WorkerProtocolService(db, blobStore, {
      leaseDurationMs: 60_000,
      baseUrl: 'http://127.0.0.1:3000',
    });

    await new CommandService(db).submit({
      region: '/artifact-fault',
      commandType: 'start',
      source: { kind: 'fault-injection' },
      payload: { ok: true },
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    const claimed = await worker.claim({
      workerId: 'artifact-fault-worker',
      capabilities: ['producer@1'],
    });
    if (!claimed.claimed) throw new Error('expected a claimed attempt');
    const envelope = claimed.envelope;
    const body = Buffer.from('{"ok":true}');
    const digest = createHash('sha256').update(body).digest('hex');
    const staged = await worker.stage({
      executionId: envelope.executionId,
      attemptId: envelope.attemptId,
      leaseToken: envelope.leaseToken,
      lifecycleEpoch: envelope.lifecycleEpoch,
      portName: 'out',
      mediaType: 'application/json',
      expectedDigest: digest,
      expectedSizeBytes: body.length,
      metadata: {},
    });
    await worker.upload(
      staged.stagedRef,
      {
        executionId: envelope.executionId,
        attemptId: envelope.attemptId,
        leaseToken: envelope.leaseToken,
        lifecycleEpoch: envelope.lifecycleEpoch,
      },
      Readable.from([body]),
    );

    const provenance = {
      kind: 'fault-injection',
      executionId: envelope.executionId,
      attemptId: envelope.attemptId,
    };
    const publication = await new ArtifactPublicationService({
      db,
      repository,
      blobStore: failFirstPromotion(blobStore),
      maxJsonBytes: 1_000_000n,
    }).publish({
      stagingRowId: staged.stagedRef,
      provenance,
    });

    expect(publication.disposition).toBe(
      'metadata_committed_promotion_pending',
    );
    expect(publication.artifact).toMatchObject({
      digest,
      schema_id: schemaId,
      provenance,
      state: 'committed',
    });
    await expect(blobStore.committedExists(digest)).resolves.toBe(false);
    await expect(blobStore.stagedExists(staged.stagedRef)).resolves.toBe(true);

    const first = await new ArtifactReconciliationService({
      db,
      repository,
      blobStore,
    }).runBatch({ limit: 10, dryRun: false });
    const second = await new ArtifactReconciliationService({
      db,
      repository,
      blobStore,
    }).runBatch({ limit: 10, dryRun: false });

    expect(first).toMatchObject({
      scanned: 1,
      promoted: 1,
      alreadyConsistent: 0,
      unresolved: [],
    });
    expect(second).toMatchObject({
      scanned: 1,
      promoted: 0,
      alreadyConsistent: 1,
      unresolved: [],
    });
    await expect(
      db.selectFrom('artifacts').selectAll().execute(),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .selectFrom('artifact_staging')
        .select(['status', 'artifact_id'])
        .where('id', '=', staged.stagedRef)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: 'promoted',
      artifact_id: publication.artifact.id,
    });
    await expect(blobStore.committedExists(digest)).resolves.toBe(true);
    await expect(blobStore.stagedExists(staged.stagedRef)).resolves.toBe(false);
    await expect(readAll(await blobStore.readCommitted(digest))).resolves.toEqual(
      body,
    );
    await expect(
      db
        .selectFrom('artifacts')
        .select('provenance')
        .where('id', '=', publication.artifact.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ provenance });
  });
});
