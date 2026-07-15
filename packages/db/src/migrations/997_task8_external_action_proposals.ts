import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table external_actions
      add column proposal_id uuid,
      add column risk text not null default 'low'
        check (risk in ('low', 'medium', 'high', 'irreversible'));

    update external_actions
      set proposal_id = id::uuid
      where proposal_id is null;

    alter table external_actions
      alter column proposal_id set not null,
      add constraint external_actions_attempt_proposal_unique
        unique (attempt_id, proposal_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table external_actions
      drop constraint if exists external_actions_attempt_proposal_unique,
      drop column if exists risk,
      drop column if exists proposal_id;
  `.execute(db);
}
