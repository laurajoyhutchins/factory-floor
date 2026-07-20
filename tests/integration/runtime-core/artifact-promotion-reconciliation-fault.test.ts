import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FilesystemArtifactBlobStore,
  type ArtifactBlobStore,
} from '../../../packages/artifact-store/src/public.js';
import { createMinioArtifactStoreFixture } from '../../../packages/artifact-store/test/minio-artifact-store-fixture.js';
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

interface ArtifactStoreFixture {
  readonly blobStore: ArtifactBlobStore;
  readonly expectedStagedLocatorPrefix: string;
  cleanup(): Promise<void>;
}

interface AdapterScenario {
  readonly name: string;
  createStore(): Promise<ArtifactStoreFixture>;
}

const adapters: AdapterScenario[] = [
  {
    name: 'filesystem',
    async createStore() {
      const root = await mkdtemp(join(tmpdir(), 'ff-artifact-fault-'));
      return {
        blobStore: new FilesystemArtifactBlobStore(root),
        expectedStagedLocatorPrefix: 'file:staging/',
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: 'minio',
    createStore: createMinioArtifactStoreFixture,
  },
];

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

async function seedRuntime(
  db: ReturnType<typeof createDatabase>,
  identity: string,
) {
  const schemaId = createUuidV7();
  const definitionId = createUuidV7();
  const regionId = createUuidV7();
  const topologyId = createUuidV7();
  const instanceId = createUuidV7();
  const regionName = `artifact-fault-${identity}`;
  const definitionName = `producer-${identity}`;

  await db
    .insertInto('artifact_schemas')
    .values({
      id: schemaId,
      name: `fault-payload-${identity}`,
      version: '1',
      content_digest: createHash('sha256')
        .update(`schema:${identity}`)
        .digest('hex'),
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
      name: definitionName,
      version: '1',
      content_digest: createHash('sha256')
        .update(`definition:${identity}`)
        .digest('hex'),
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
    .values({ id: regionId, name: regionName })
    .execute();
  await db
    .insertInto('topology_revisions')
    .values({
      id: topologyId,
      region_id: regionId,
      revision_number: 1,
      content_digest: createHash('sha256')
        .update(`topology:${identity}`)
        .digest('hex'),
      topology: {
        ingress: {
          commands: {
            start: { targets: [{ component: definitionName, port: 'in' }] },
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
      name: definitionName,
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

  return {
    schemaId,
    regionName,
    componentSelector: `${definitionName}@1`,
  };
}

async function runScenario(scenario: AdapterScenario) {
  const identity = randomUUID().replaceAll('-', '').slice(0, 12);
  const databaseName = `ff_artifact_fault_${randomUUID().replaceAll('-', '')}`;
  const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);
  let databaseCreated = false;
  let db: ReturnType<typeof createDatabase> | undefined;
  let store: ArtifactStoreFixture | undefined;

  try {
    await admin.query(`create database ${databaseName}`);
    databaseCreated = true;
    db = createDatabase(testUrl);
    expect((await migrateToLatest(db)).error).toBeUndefined();
    store = await scenario.createStore();

    const runtime = await seedRuntime(db, identity);
    const repository = new ArtifactRepository();
    const worker = new WorkerProtocolService(db, store.blobStore, {
      leaseDurationMs: 60_000,
      baseUrl: 'http://127.0.0.1:3000',
    });

    await new CommandService(db).submit({
      region: `/${runtime.regionName}`,
      commandType: 'start',
      source: { kind: `fault-injection-${scenario.name}` },
      payload: { ok: true },
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    const claimed = await worker.claim({
      workerId: `artifact-fault-${scenario.name}-${identity}`,
      capabilities: [runtime.componentSelector],
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
    const upload = await db
      .selectFrom('worker_artifact_uploads')
      .select('artifact_staging_id')
      .where('staged_ref', '=', staged.stagedRef)
      .executeTakeFirstOrThrow();
    if (!upload.artifact_staging_id) {
      throw new Error('worker upload did not create durable artifact staging');
    }
    const stagingRowId = upload.artifact_staging_id;
    const stagedRow = await db
      .selectFrom('artifact_staging')
      .select('locator')
      .where('id', '=', stagingRowId)
      .executeTakeFirstOrThrow();
    expect(stagedRow.locator).toBe(
      `${store.expectedStagedLocatorPrefix}${staged.stagedRef}`,
    );

    const provenance = {
      kind: 'fault-injection',
      adapter: scenario.name,
      executionId: envelope.executionId,
      attemptId: envelope.attemptId,
    };
    const publication = await new ArtifactPublicationService({
      db,
      repository,
      blobStore: failFirstPromotion(store.blobStore),
      maxJsonBytes: 1_000_000n,
    }).publish({
      stagingRowId,
      provenance,
    });

    expect(publication.disposition).toBe(
      'metadata_committed_promotion_pending',
    );
    expect(publication.artifact).toMatchObject({
      digest,
      schema_id: runtime.schemaId,
      provenance,
      state: 'committed',
    });
    await expect(store.blobStore.committedExists(digest)).resolves.toBe(false);
    await expect(store.blobStore.stagedExists(staged.stagedRef)).resolves.toBe(
      true,
    );

    const first = await new ArtifactReconciliationService({
      db,
      repository,
      blobStore: store.blobStore,
    }).runBatch({ limit: 10, dryRun: false });
    const second = await new ArtifactReconciliationService({
      db,
      repository,
      blobStore: store.blobStore,
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
      db
        .selectFrom('artifacts')
        .selectAll()
        .where('digest', '=', digest)
        .execute(),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .selectFrom('artifact_staging')
        .select(['status', 'artifact_id'])
        .where('id', '=', stagingRowId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: 'promoted',
      artifact_id: publication.artifact.id,
    });
    await expect(store.blobStore.committedExists(digest)).resolves.toBe(true);
    await expect(store.blobStore.stagedExists(staged.stagedRef)).resolves.toBe(
      false,
    );
    await expect(
      readAll(await store.blobStore.readCommitted(digest)),
    ).resolves.toEqual(body);
    await expect(
      db
        .selectFrom('artifacts')
        .select('provenance')
        .where('id', '=', publication.artifact.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ provenance });
  } finally {
    await cleanupScenario(store, db, databaseName, databaseCreated);
  }
}

async function cleanupScenario(
  store: ArtifactStoreFixture | undefined,
  db: ReturnType<typeof createDatabase> | undefined,
  databaseName: string,
  databaseCreated: boolean,
) {
  const errors: unknown[] = [];
  try {
    await store?.cleanup();
  } catch (error) {
    errors.push(error);
  }
  try {
    await db?.destroy();
  } catch (error) {
    errors.push(error);
  }
  if (databaseCreated) {
    try {
      await admin.query(`drop database if exists ${databaseName}`);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'artifact fault scenario cleanup failed');
  }
}

afterAll(async () => {
  await admin.end();
});

describe.each(adapters)(
  '$name artifact promotion reconciliation fault injection',
  (scenario) => {
    it('converges metadata committed before promotion exactly once', async () => {
      await runScenario(scenario);
    });
  },
);
