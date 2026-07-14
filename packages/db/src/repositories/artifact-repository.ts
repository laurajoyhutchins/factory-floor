import type { RuntimeDb, Json } from '../database.js';
import { createUuidV7 } from '../ids.js';
export class ArtifactRepository {
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
    return db
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
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
