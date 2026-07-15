import type { Kysely } from 'kysely';
import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import type { ArtifactRepository, Database, Json } from '@factory-floor/db';
import { ArtifactDomainError } from './errors.js';
import { ArtifactValidationService } from './artifact-validation-service.js';

export interface PublishStagedArtifactInput {
  stagingRowId: string;
  provenance: Json;
}
export type PublicationDisposition =
  | 'created'
  | 'existing'
  | 'metadata_committed_blob_promoted'
  | 'metadata_committed_promotion_pending';

export class ArtifactPublicationService {
  constructor(
    private readonly deps: {
      db: Kysely<Database>;
      repository: ArtifactRepository;
      blobStore: ArtifactBlobStore;
      maxJsonBytes: bigint;
    },
  ) {}

  async publish(input: PublishStagedArtifactInput) {
    await new ArtifactValidationService({
      ...this.deps,
    }).validateStagedArtifact(input.stagingRowId);
    let disposition: PublicationDisposition = 'created';
    const artifact = await this.deps.db.transaction().execute(async (trx) => {
      const row = await this.deps.repository.lockStagingRow(
        trx,
        input.stagingRowId,
      );
      if (!row)
        throw new ArtifactDomainError(
          'staging_not_found',
          'staging row was not found',
        );
      if (row.status !== 'staged')
        throw new ArtifactDomainError(
          'staging_not_active',
          'staging row is not active',
        );

      const existing = await this.deps.repository.lockArtifactByDigest(
        trx,
        row.digest,
      );
      if (existing) {
        this.assertCompatible(existing, row);
        await this.deps.repository.linkStagingRowToArtifact(
          trx,
          row.id,
          existing.id,
        );
        disposition = 'existing';
        return existing;
      }

      const result =
        await this.deps.repository.createCommittedArtifactIdempotently(trx, {
          digest: row.digest,
          sizeBytes: row.size_bytes,
          schemaId: row.schema_id,
          mediaType: row.media_type,
          locator: `sha256:${row.digest}`,
          provenance: input.provenance,
        });
      this.assertCompatible(result.artifact, row);
      if (!result.created) disposition = 'existing';
      await this.deps.repository.linkStagingRowToArtifact(
        trx,
        row.id,
        result.artifact.id,
      );
      return result.artifact;
    });

    try {
      await this.deps.blobStore.promote(
        input.stagingRowId,
        artifact.digest,
        BigInt(artifact.size_bytes),
      );
      await this.deps.db.transaction().execute(async (trx) => {
        await this.deps.repository.markStagingPromoted(
          trx,
          input.stagingRowId,
          artifact.id,
        );
      });
      return {
        artifact,
        disposition:
          disposition === 'created'
            ? ('metadata_committed_blob_promoted' as const)
            : disposition,
      };
    } catch {
      return {
        artifact,
        disposition: 'metadata_committed_promotion_pending' as const,
      };
    }
  }

  private assertCompatible(
    artifact: {
      state: string;
      size_bytes: string;
      schema_id: string;
      media_type: string;
    },
    staging: { size_bytes: string; schema_id: string; media_type: string },
  ) {
    if (artifact.state === 'tombstoned')
      throw new ArtifactDomainError(
        'artifact_tombstoned',
        'artifact digest is tombstoned',
      );
    if (
      artifact.size_bytes !== staging.size_bytes ||
      artifact.schema_id !== staging.schema_id ||
      artifact.media_type !== staging.media_type
    )
      throw new ArtifactDomainError(
        'artifact_conflict',
        'artifact identity conflicts with existing digest',
      );
  }
}
