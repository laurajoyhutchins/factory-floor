import type { Kysely } from 'kysely';
import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import type { ArtifactRepository, Database } from '@factory-floor/db';
import { ArtifactDomainError } from './errors.js';

export interface ArtifactReconciliationReport {
  dryRun: boolean;
  scanned: number;
  promoted: number;
  wouldPromote: number;
  alreadyConsistent: number;
  abandonedMetadataRows: number;
  wouldAbandonMetadataRows: number;
  orphanStagedObjects: number;
  removedOrphanObjects: number;
  wouldRemoveOrphanObjects: number;
  unresolved: Array<{ code: string; id: string; message: string }>;
  nextCursor?: string;
}

interface ArtifactReconciliationCursor {
  blob?: string;
}

export function encodeArtifactReconciliationCursor(value: unknown) {
  return Buffer.from(JSON.stringify({ v: 1, value }), 'utf8').toString(
    'base64url',
  );
}

export function decodeArtifactReconciliationCursor(
  cursor: string,
): ArtifactReconciliationCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { v?: unknown; value?: unknown };
    if (parsed.v !== 1 || typeof parsed.value !== 'object' || parsed.value === null)
      throw new Error('bad cursor');
    const value = parsed.value as { blob?: unknown };
    if (value.blob !== undefined && typeof value.blob !== 'string')
      throw new Error('bad blob cursor');
    return value as ArtifactReconciliationCursor;
  } catch {
    throw new ArtifactDomainError(
      'reconciliation_unresolved',
      'malformed reconciliation cursor',
    );
  }
}

export class ArtifactReconciliationService {
  constructor(
    private readonly deps: {
      db: Kysely<Database>;
      repository: ArtifactRepository;
      blobStore: ArtifactBlobStore;
      clock?: () => Date;
    },
  ) {}

  async runBatch(input: {
    limit: number;
    cursor?: string;
    removeOrphans?: boolean;
    orphanGraceSeconds?: number;
    dryRun?: boolean;
  }): Promise<ArtifactReconciliationReport> {
    if (!Number.isInteger(input.limit) || input.limit < 1)
      throw new ArtifactDomainError(
        'reconciliation_unresolved',
        'reconciliation limit must be a positive integer',
      );
    if ((input.orphanGraceSeconds ?? 3600) < 0)
      throw new ArtifactDomainError(
        'reconciliation_unresolved',
        'orphan grace period must not be negative',
      );

    const cursor = input.cursor
      ? decodeArtifactReconciliationCursor(input.cursor)
      : {};
    const dryRun = input.dryRun ?? false;
    const now = (this.deps.clock ?? (() => new Date()))();
    const cutoff = new Date(
      now.getTime() - (input.orphanGraceSeconds ?? 3600) * 1000,
    );
    const report: ArtifactReconciliationReport = {
      dryRun,
      scanned: 0,
      promoted: 0,
      wouldPromote: 0,
      alreadyConsistent: 0,
      abandonedMetadataRows: 0,
      wouldAbandonMetadataRows: 0,
      orphanStagedObjects: 0,
      removedOrphanObjects: 0,
      wouldRemoveOrphanObjects: 0,
      unresolved: [],
    };

    const artifacts =
      await this.deps.repository.findCommittedArtifactsNeedingBlobCheck(
        this.deps.db,
        input.limit,
      );
    for (const artifact of artifacts) {
      report.scanned++;
      if (await this.deps.blobStore.committedExists(artifact.digest)) {
        report.alreadyConsistent++;
        continue;
      }
      const staging = (
        await this.deps.repository.readStagingRowsByArtifactId(
          this.deps.db,
          artifact.id,
        )
      ).find((row) => row.status === 'staged');
      if (!staging) {
        report.unresolved.push({
          code: 'missing_committed_bytes',
          id: artifact.id,
          message: 'committed artifact bytes are missing',
        });
        continue;
      }
      if (dryRun) {
        report.wouldPromote++;
        continue;
      }
      await this.deps.blobStore.promote(
        staging.id,
        artifact.digest,
        BigInt(artifact.size_bytes),
      );
      await this.deps.repository.markStagingPromoted(
        this.deps.db,
        staging.id,
        artifact.id,
        now,
      );
      report.promoted++;
    }

    const staged = await this.deps.repository.listReconciliationCandidates(
      this.deps.db,
      { status: 'staged', before: cutoff, limit: input.limit },
    );
    for (const row of staged) {
      if (await this.deps.blobStore.stagedExists(row.id)) continue;
      if (dryRun) report.wouldAbandonMetadataRows++;
      else {
        await this.deps.repository.markStagingAbandoned(
          this.deps.db,
          row.id,
          now,
        );
        report.abandonedMetadataRows++;
      }
    }

    const page = await this.deps.blobStore.listStaged({
      limit: input.limit,
      cursor: cursor.blob,
    });
    for (const object of page.objects) {
      const rows = await this.deps.repository.readStagingRowsByLocator(
        this.deps.db,
        object.stagedLocator,
      );
      if (rows.length !== 0 || object.lastModifiedAt >= cutoff) continue;
      report.orphanStagedObjects++;
      if (!input.removeOrphans) continue;
      if (dryRun) report.wouldRemoveOrphanObjects++;
      else {
        await this.deps.blobStore.removeStaged(object.stagingId);
        report.removedOrphanObjects++;
      }
    }
    if (page.nextCursor)
      report.nextCursor = encodeArtifactReconciliationCursor({
        blob: page.nextCursor,
      });
    return report;
  }
}
