import { sql, type Kysely } from 'kysely';
import type { Database } from '../database.js';

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    alter table artifact_staging
      add column artifact_id uuidv7 references artifacts(id),
      add column promoted_at timestamptz,
      add column abandoned_at timestamptz;
    create unique index artifact_staging_locator_unique on artifact_staging(locator);
    create index artifact_staging_status_created_at_idx on artifact_staging(status, created_at);
    create index artifact_staging_artifact_id_idx on artifact_staging(artifact_id);
    alter table artifact_staging
      add constraint artifact_staging_status_consistency check (
        (status = 'staged' and promoted_at is null and abandoned_at is null)
        or (status = 'promoted' and artifact_id is not null and promoted_at is not null and abandoned_at is null)
        or (status = 'abandoned' and abandoned_at is not null and promoted_at is null)
      ),
      add constraint artifact_staging_not_promoted_and_abandoned check (promoted_at is null or abandoned_at is null);
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`
    alter table artifact_staging drop constraint if exists artifact_staging_not_promoted_and_abandoned;
    alter table artifact_staging drop constraint if exists artifact_staging_status_consistency;
    drop index if exists artifact_staging_artifact_id_idx;
    drop index if exists artifact_staging_status_created_at_idx;
    drop index if exists artifact_staging_locator_unique;
    alter table artifact_staging
      drop column if exists abandoned_at,
      drop column if exists promoted_at,
      drop column if exists artifact_id;
  `.execute(db);
}
