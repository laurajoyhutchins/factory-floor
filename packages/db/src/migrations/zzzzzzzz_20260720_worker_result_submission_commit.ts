import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table worker_result_submissions
      add column committed_at timestamptz;

    update worker_result_submissions as submission
      set committed_at = coalesce(attempt.completed_at, submission.created_at)
      from execution_attempts as attempt
      inner join executions as execution
        on execution.id = attempt.execution_id
      where submission.attempt_id = attempt.id
        and submission.execution_id = execution.id
        and (
          (
            submission.result ->> 'status' = 'completed'
            and attempt.status = 'completed'
            and execution.status = 'completed'
          )
          or (
            submission.result ->> 'status' = 'failed'
            and attempt.status = 'failed'
          )
          or (
            submission.result ->> 'status' = 'cancelled'
            and attempt.status = 'cancelled'
            and exists (
              select 1
              from execution_inputs as input
              inner join deliveries as delivery
                on delivery.id = input.delivery_id
              where input.execution_id = execution.id
                and delivery.status = 'dead_lettered'
            )
          )
        );

    create index worker_result_submissions_pending_idx
      on worker_result_submissions (created_at, id)
      where committed_at is null;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop index if exists worker_result_submissions_pending_idx;
    alter table worker_result_submissions
      drop column if exists committed_at;
  `.execute(db);
}
