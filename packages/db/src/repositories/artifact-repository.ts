import type { ArtifactStagingState, RuntimeDb, Json } from '../database.js';
import { createUuidV7 } from '../ids.js';

export class ArtifactRepository {
  readArtifactSchemaById(db: RuntimeDb, id: string) {
    return db
      .selectFrom('artifact_schemas')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }
  readStagingById(db: RuntimeDb, id: string) {
    return db
      .selectFrom('artifact_staging')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }
  lockStagingRow(db: RuntimeDb, id: string) {
    return db
      .selectFrom('artifact_staging')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }
  readStagingRowsByLocator(db: RuntimeDb, locator: string) {
    return db
      .selectFrom('artifact_staging')
      .selectAll()
      .where('locator', '=', locator)
      .execute();
  }
  readStagingRowsByArtifactId(db: RuntimeDb, artifactId: string) {
    return db
      .selectFrom('artifact_staging')
      .selectAll()
      .where('artifact_id', '=', artifactId)
      .orderBy('created_at')
      .execute();
  }
  readArtifactByDigest(db: RuntimeDb, digest: string) {
    return db
      .selectFrom('artifacts')
      .selectAll()
      .where('digest_algorithm', '=', 'sha256')
      .where('digest', '=', digest)
      .executeTakeFirst();
  }
  lockArtifactByDigest(db: RuntimeDb, digest: string) {
    return db
      .selectFrom('artifacts')
      .selectAll()
      .where('digest_algorithm', '=', 'sha256')
      .where('digest', '=', digest)
      .forUpdate()
      .executeTakeFirst();
  }
  lockArtifactById(db: RuntimeDb, id: string) {
    return db
      .selectFrom('artifacts')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }
  async createCommittedArtifactIdempotently(
    db: RuntimeDb,
    input: {
      digest: string;
      sizeBytes: string;
      schemaId: string;
      mediaType: string;
      locator: string;
      provenance: Json;
    },
  ) {
    const inserted = await db
      .insertInto('artifacts')
      .values({
        id: createUuidV7(),
        digest_algorithm: 'sha256',
        digest: input.digest,
        size_bytes: input.sizeBytes,
        schema_id: input.schemaId,
        state: 'committed',
        media_type: input.mediaType,
        committed_locator: input.locator,
        provenance: input.provenance,
      })
      .onConflict((conflict) =>
        conflict.columns(['digest_algorithm', 'digest']).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    if (inserted) return { artifact: inserted, created: true as const };
    const existing = await this.lockArtifactByDigest(db, input.digest);
    if (!existing)
      throw new Error('artifact insert conflicted but no artifact was found');
    return { artifact: existing, created: false as const };
  }
  async createCommittedArtifact(
    db: RuntimeDb,
    input: {
      digest: string;
      sizeBytes: string;
      schemaId: string;
      mediaType: string;
      locator: string;
      provenance: Json;
    },
  ) {
    return (await this.createCommittedArtifactIdempotently(db, input)).artifact;
  }
  linkStagingRowToArtifact(
    db: RuntimeDb,
    stagingRowId: string,
    artifactId: string,
  ) {
    return db
      .updateTable('artifact_staging')
      .set({ artifact_id: artifactId })
      .where('id', '=', stagingRowId)
      .returningAll()
      .executeTakeFirst();
  }
  markStagingPromoted(
    db: RuntimeDb,
    stagingRowId: string,
    artifactId: string,
    at = new Date(),
  ) {
    return db
      .updateTable('artifact_staging')
      .set({
        status: 'promoted',
        artifact_id: artifactId,
        promoted_at: at,
        abandoned_at: null,
      })
      .where('id', '=', stagingRowId)
      .returningAll()
      .executeTakeFirst();
  }
  markStagingAbandoned(db: RuntimeDb, stagingRowId: string, at = new Date()) {
    return db
      .updateTable('artifact_staging')
      .set({ status: 'abandoned', abandoned_at: at, promoted_at: null })
      .where('id', '=', stagingRowId)
      .returningAll()
      .executeTakeFirst();
  }
  listReconciliationCandidates(
    db: RuntimeDb,
    input: { status?: ArtifactStagingState; before?: Date; limit: number },
  ) {
    let query = db
      .selectFrom('artifact_staging')
      .selectAll()
      .orderBy('created_at')
      .limit(input.limit);
    if (input.status) query = query.where('status', '=', input.status);
    if (input.before)
      query = query.where('created_at', '<', input.before as never);
    return query.execute();
  }
  tombstoneArtifact(db: RuntimeDb, id: string, at = new Date()) {
    return db
      .updateTable('artifacts')
      .set({ state: 'tombstoned', tombstoned_at: at, committed_locator: null })
      .where('id', '=', id)
      .where('state', '<>', 'tombstoned')
      .returningAll()
      .executeTakeFirst();
  }
  findCommittedArtifactsNeedingBlobCheck(db: RuntimeDb, limit: number) {
    return db
      .selectFrom('artifacts')
      .selectAll()
      .where('state', '=', 'committed')
      .orderBy('created_at')
      .limit(limit)
      .execute();
  }
}
