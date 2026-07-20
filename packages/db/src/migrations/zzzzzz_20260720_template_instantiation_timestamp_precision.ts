import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update template_instantiations
    set created_at = date_trunc('milliseconds', created_at)
    where created_at <> date_trunc('milliseconds', created_at);

    alter table template_instantiations
      alter column created_at
      set default date_trunc('milliseconds', now());
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table template_instantiations
      alter column created_at
      set default now();
  `.execute(db);
}
