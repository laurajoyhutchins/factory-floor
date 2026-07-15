import type { Kysely } from 'kysely';
import type { ArtifactRepository, Database } from '@factory-floor/db';
export class ArtifactTombstoneService {
  constructor(private readonly deps: { db: Kysely<Database>; repository: ArtifactRepository; clock?: () => Date }) {}
  async tombstone(artifactId: string) {
    return this.deps.db.transaction().execute(async trx => {
      const row = await this.deps.repository.lockArtifactById(trx, artifactId);
      if (!row) return undefined;
      if (row.state === 'tombstoned') return row;
      return this.deps.repository.tombstoneArtifact(trx, artifactId, (this.deps.clock ?? (() => new Date()))());
    });
  }
}
