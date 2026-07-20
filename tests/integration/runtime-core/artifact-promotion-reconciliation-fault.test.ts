import { describe, expect, it } from 'vitest';
import { ArtifactReconciliationService } from '../../../packages/runtime-core/src/index.js';
import {
  artifactStoreAdapters,
  preparePendingArtifact,
  readAll,
} from './artifact-reconciliation-fault-fixture.js';

describe.each(artifactStoreAdapters)(
  '$name artifact promotion reconciliation fault injection',
  (scenario) => {
    it('converges metadata committed before promotion exactly once', async () => {
      const context = await preparePendingArtifact(scenario);
      try {
        expect(context.publication.disposition).toBe(
          'metadata_committed_promotion_pending',
        );
        expect(context.publication.artifact).toMatchObject({
          digest: context.digest,
          schema_id: context.runtime.schemaId,
          provenance: context.provenance,
          state: 'committed',
        });
        const stagedRow = await context.db
          .selectFrom('artifact_staging')
          .select('locator')
          .where('id', '=', context.stagingRowId)
          .executeTakeFirstOrThrow();
        expect(stagedRow.locator).toBe(
          `${context.store.expectedStagedLocatorPrefix}${context.stagedRef}`,
        );
        await expect(
          context.store.blobStore.committedExists(context.digest),
        ).resolves.toBe(false);
        await expect(
          context.store.blobStore.stagedExists(context.stagedRef),
        ).resolves.toBe(true);

        const first = await new ArtifactReconciliationService({
          db: context.db,
          repository: context.repository,
          blobStore: context.store.blobStore,
        }).runBatch({ limit: 10, dryRun: false });
        const second = await new ArtifactReconciliationService({
          db: context.db,
          repository: context.repository,
          blobStore: context.store.blobStore,
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
          status: 'promoted',
          artifact_id: context.publication.artifact.id,
        });
        await expect(
          context.store.blobStore.committedExists(context.digest),
        ).resolves.toBe(true);
        await expect(
          context.store.blobStore.stagedExists(context.stagedRef),
        ).resolves.toBe(false);
        await expect(
          readAll(await context.store.blobStore.readCommitted(context.digest)),
        ).resolves.toEqual(context.body);
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
    });
  },
);
