import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> { await sql`
create table worker_result_submissions (
  id uuidv7 primary key,
  execution_id uuidv7 not null,
  attempt_id uuidv7 not null,
  submission_digest sha256_digest not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique(attempt_id),
  foreign key(execution_id, attempt_id) references execution_attempts(execution_id, id)
);
`.execute(db); }
export async function down(db: Kysely<unknown>): Promise<void> { await sql`drop table if exists worker_result_submissions;`.execute(db); }
