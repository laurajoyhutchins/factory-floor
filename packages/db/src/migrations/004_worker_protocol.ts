import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table worker_artifact_uploads (
      id uuidv7 primary key,
      staged_ref uuidv7 not null unique,
      execution_id uuidv7 not null,
      attempt_id uuidv7 not null,
      lifecycle_epoch integer not null check (lifecycle_epoch >= 0),
      port_name text not null,
      schema_id uuidv7 not null references artifact_schemas(id),
      media_type text not null,
      expected_digest sha256_digest not null,
      expected_size_bytes bigint not null check (expected_size_bytes >= 0),
      metadata jsonb not null default '{}'::jsonb,
      expires_at timestamptz not null,
      uploaded_at timestamptz,
      artifact_staging_id uuidv7 unique references artifact_staging(id),
      created_at timestamptz not null default now(),
      foreign key(execution_id, attempt_id)
        references execution_attempts(execution_id, id)
    );

    create index worker_artifact_uploads_attempt_idx
      on worker_artifact_uploads(attempt_id, expires_at);

    create table worker_result_submissions (
      id uuidv7 primary key,
      execution_id uuidv7 not null,
      attempt_id uuidv7 not null,
      submission_digest sha256_digest not null,
      result jsonb not null,
      created_at timestamptz not null default now(),
      unique(attempt_id),
      foreign key(execution_id, attempt_id)
        references execution_attempts(execution_id, id)
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists worker_result_submissions;`.execute(db);
  await sql`drop table if exists worker_artifact_uploads;`.execute(db);
}
