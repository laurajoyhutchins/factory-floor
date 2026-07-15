import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table deliveries
      add column dead_lettered_at timestamptz;

    alter table deliveries
      add constraint deliveries_dead_lettered_at_check
        check ((status = 'dead_lettered') = (dead_lettered_at is not null));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table deliveries
      drop constraint if exists deliveries_dead_lettered_at_check,
      drop column if exists dead_lettered_at;
  `.execute(db);
}
