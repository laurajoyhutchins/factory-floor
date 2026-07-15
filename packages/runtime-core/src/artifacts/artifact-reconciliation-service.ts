import type { Kysely } from 'kysely';
import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import type { ArtifactRepository, Database } from '@factory-floor/db';
import { ArtifactDomainError } from './errors.js';

export interface ArtifactReconciliationReport { scanned: number; promoted: number; alreadyConsistent: number; abandonedMetadataRows: number; orphanStagedObjects: number; removedOrphanObjects: number; unresolved: Array<{ code: string; id: string; message: string }>; nextCursor?: string }
export function encodeArtifactReconciliationCursor(value: unknown) { return Buffer.from(JSON.stringify({ v: 1, value }), 'utf8').toString('base64url'); }
export function decodeArtifactReconciliationCursor(cursor: string) { try { const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')); if (parsed.v !== 1) throw new Error('bad version'); return parsed.value; } catch { throw new ArtifactDomainError('reconciliation_unresolved','malformed reconciliation cursor'); } }

export class ArtifactReconciliationService {
  constructor(private readonly deps: { db: Kysely<Database>; repository: ArtifactRepository; blobStore: ArtifactBlobStore; clock?: () => Date }) {}
  async runBatch(input: { limit: number; cursor?: string; removeOrphans?: boolean; orphanGraceSeconds?: number }): Promise<ArtifactReconciliationReport> {
    if (input.cursor) decodeArtifactReconciliationCursor(input.cursor);
    const report: ArtifactReconciliationReport = { scanned:0, promoted:0, alreadyConsistent:0, abandonedMetadataRows:0, orphanStagedObjects:0, removedOrphanObjects:0, unresolved:[] };
    const artifacts = await this.deps.repository.findCommittedArtifactsNeedingBlobCheck(this.deps.db, input.limit);
    for (const artifact of artifacts) {
      report.scanned++;
      const exists = await this.deps.blobStore.committedExists(artifact.digest);
      if (exists) { report.alreadyConsistent++; continue; }
      const staging = (await this.deps.repository.readStagingRowsByArtifactId(this.deps.db, artifact.id)).find(s => s.status === 'staged');
      if (!staging) { report.unresolved.push({ code:'missing_committed_bytes', id:artifact.id, message:'committed artifact bytes are missing' }); continue; }
      await this.deps.blobStore.promote(staging.id, artifact.digest, BigInt(artifact.size_bytes));
      await this.deps.repository.markStagingPromoted(this.deps.db, staging.id, artifact.id, (this.deps.clock ?? (()=>new Date()))());
      report.promoted++;
    }
    const staged = await this.deps.repository.listReconciliationCandidates(this.deps.db, { status:'staged', limit: input.limit });
    const cutoff = new Date((this.deps.clock ?? (()=>new Date()))().getTime() - (input.orphanGraceSeconds ?? 3600)*1000);
    for (const row of staged) if (!(await this.deps.blobStore.stagedExists(row.id)) && (row.created_at as unknown as Date).getTime() < cutoff.getTime()) { await this.deps.repository.markStagingAbandoned(this.deps.db, row.id); report.abandonedMetadataRows++; }
    const page = await this.deps.blobStore.listStaged({ limit: input.limit });
    for (const object of page.objects) {
      const rows = await this.deps.repository.readStagingRowsByLocator(this.deps.db, object.stagedLocator);
      if (rows.length === 0) { report.orphanStagedObjects++; if (input.removeOrphans) { await this.deps.blobStore.removeStaged(object.stagingId); report.removedOrphanObjects++; } }
    }
    if (page.nextCursor) report.nextCursor = encodeArtifactReconciliationCursor({ blob: page.nextCursor });
    return report;
  }
}
