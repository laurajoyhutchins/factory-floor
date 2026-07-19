import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table if not exists activity_instance_bindings (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      application_id text not null,
      instance_id text not null,
      installation_id text not null,
      guild_id text,
      channel_id text,
      thread_id text,
      launch_id text not null,
      installation_identifier text not null,
      bound_run_id text,
      bound_view jsonb not null default '{}'::jsonb,
      principal_id text not null,
      adapter text not null,
      expires_at timestamptz not null,
      closed_at timestamptz,
      constraint uq_activity_instance unique (application_id, instance_id)
    );

    create index if not exists idx_activity_instance_expiry
      on activity_instance_bindings(expires_at);

    create table if not exists activity_sessions (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      instance_binding_id uuid not null
        references activity_instance_bindings(id) on delete cascade,
      principal_id text not null,
      token_digest text not null,
      expires_at timestamptz not null,
      idle_expires_at timestamptz not null,
      revoked_at timestamptz,
      refreshed_at timestamptz,
      constraint uq_activity_session_token unique (token_digest)
    );

    create index if not exists idx_activity_sessions_binding
      on activity_sessions(instance_binding_id);
    create index if not exists idx_activity_sessions_expiry
      on activity_sessions(expires_at, idle_expires_at);

    create table if not exists activity_collaborative_state (
      id uuid primary key default gen_random_uuid(),
      instance_binding_id uuid not null
        references activity_instance_bindings(id) on delete cascade,
      state_key text not null,
      state_value jsonb not null default '{}'::jsonb,
      revision integer not null default 1,
      updated_at timestamptz not null default now(),
      constraint uq_activity_collaborative_state_key
        unique (instance_binding_id, state_key)
    );

    create table if not exists service_request_nonces (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      key_id text not null,
      nonce text not null,
      constraint uq_service_request_nonce unique (key_id, nonce)
    );

    create index if not exists idx_service_request_nonces_created
      on service_request_nonces(created_at);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists service_request_nonces;
    drop table if exists activity_collaborative_state;
    drop table if exists activity_sessions;
    drop table if exists activity_instance_bindings;
  `.execute(db);
}
