import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ArtifactBlobStore } from '../../../packages/artifact-store/src/public.js';
import { ArtifactReconciliationService } from '../../../packages/runtime-core/src/index.js';
import {
  artifactStoreAdapters,
  preparePendingArtifact,
} from './artifact-reconciliation-fault-fixture.js';

const recoveryFailures = [
  {
    name: 'missing staged bytes',
    code: 'missing_staged_bytes',
    async inject(store: ArtifactBlobStore, stagedRef: string) {
      await store.removeStaged(stagedRef);
    },
    message(stagingRowId: string) {
      return `staged recovery bytes are missing for staging row ${stagingRowId}`;
    },
  },
  {
    name: 'mismatched staged bytes',
    code: 'staged_bytes_mismatch',
    async inject(store: ArtifactBlobStore, stagedRef: string) {
      await store.removeStaged(stagedRef);
      await store.stage(stagedRef, Readable.from(['{"ok":null}']));
    },
    message(stagingRowId: string) {
      return `staged recovery bytes do not match committed artifact metadata for staging row ${stagingRowId}`;
    },
  },
] as const;

function throwUnknownPromotionError(
  delegate: ArtifactBlobStore,
): ArtifactBlobStore {
  return {
    stage: delegate.stage.bind(delegate),
    readStaged: delegate.readStaged.bind(delegate),
    async promote() {
      throw new Error('injected unknown promotion failure');
    },
    readCommitted: delegate.readCommitted.bind(delegate),
    removeStaged: delegate.removeStaged.bind(delegate),
    stagedExists: delegate.stagedExists.bind(delegate),
    committedExists: delegate.committedExists.bind(delegate),
    listStaged: delegate.listStaged.bind(delegate),
  };
}

describe.each(artifactStoreAdapters)(
  '$name artifact reconciliation diagnostics',
  (scenario) => {
    it.each(recoveryFailures)(
      'reports stable $name without changing authoritative state',
      async (failure) => {
        const context = await preparePendingArtifact(scenario);
        try {
          await failure.inject(context.store.blobStore, context.stagedRef);
          const reconciliationTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
          const reconcile = () =>
            new ArtifactReconciliationService({
              db: context.db,
              repository: context.repository,
              blobStore: context.store.blobStore,
              clock: () => reconciliationTime,
            }).runBatch({ limit: 10, dryRun: false });

          const first = await reconcile();
          const second = await reconcile();
          const unresolved = [
            {
              code: failure.code,
              id: context.publication.artifact.id,
              message: failure.message(context.stagingRowId),
            },
          ];

          expect(first).toMatchObject({
            scanned: 1,
            promoted: 0,
            alreadyConsistent: 0,
            abandonedMetadataRows: 0,
            unresolved,
          });
          expect(second).toMatchObject({
            scanned: 1,
            promoted: 0,
            alreadyConsistent: 0,
            abandonedMetadataRows: 0,
            unresolved,
          });
          expect(second.unresolved).toEqual(first.unresolved);
          await expect(
            context.db
              .selectFrom('artifacts')
              .selectAll()
              .where('digest', '=', context.digest)
              .execute(),
          ).resolves.toHaveLength(1);
          await expect(
            context.db
              .selectFrom('artifact_staging')
              .select(['status', 'artifact_id'])
              .where('id', '=', context.stagingRowId)
              .executeTakeFirstOrThrow(),
          ).resolves.toEqual({
            status: 'staged',
            artifact_id: context.publication.artifact.id,
          });
          await expect(
            context.store.blobStore.committedExists(context.digest),
          ).resolves.toBe(false);
          await expect(
            context.db
              .selectFrom('artifacts')
              .select('provenance')
              .where('id', '=', context.publication.artifact.id)
              .executeTakeFirstOrThrow(),
          ).resolves.toEqual({ provenance: context.provenance });
        } finally {
          await context.cleanup();
        }
      },
    );
  },
);

describe('artifact reconciliation unknown errors', () => {
  it('does not convert unknown promotion failures into diagnostics', async () => {
    const filesystem = artifactStoreAdapters.find(
      (scenario) => scenario.name === 'filesystem',
    );
    if (!filesystem) throw new Error('filesystem adapter scenario is required');
    const context = await preparePendingArtifact(filesystem);
    try {
      const reconciliation = new ArtifactReconciliationService({
        db: context.db,
        repository: context.repository,
        blobStore: throwUnknownPromotionError(context.store.blobStore),
      });

      await expect(
        reconciliation.runBatch({ limit: 10, dryRun: false }),
      ).rejects.toThrow('injected unknown promotion failure');
      await expect(
        context.db
          .selectFrom('artifact_staging')
          .select(['status', 'artifact_id'])
          .where('id', '=', context.stagingRowId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        status: 'staged',
        artifact_id: context.publication.artifact.id,
      });
    } finally {
      await context.cleanup();
    }
  });
});
