import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table execution_attempts
      drop constraint if exists execution_attempts_check2,
      drop constraint if exists execution_attempts_check3;

    alter table execution_attempts
      add constraint execution_attempts_terminal_completed_at_check
        check (
          (status in ('completed', 'failed', 'cancelled', 'abandoned')) =
          (completed_at is not null)
        ),
      add constraint execution_attempts_failed_failure_check
        check ((status = 'failed') = (failure is not null));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table execution_attempts
      drop constraint if exists execution_attempts_terminal_completed_at_check,
      drop constraint if exists execution_attempts_failed_failure_check;

    alter table execution_attempts
      add constraint execution_attempts_check2
        check ((status = 'completed') = (completed_at is not null)) not valid,
      add constraint execution_attempts_check3
        check (
          (status = 'failed') =
          (completed_at is not null and failure is not null)
        ) not valid;
  `.execute(db);
}
