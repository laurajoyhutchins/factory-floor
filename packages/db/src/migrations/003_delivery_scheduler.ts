import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
alter table commands add column if not exists source jsonb not null default '{}';
alter table commands add column if not exists request_digest sha256_digest;
alter table commands add column if not exists rejection jsonb;
alter table commands add column if not exists accepted_at timestamptz;
alter table commands add column if not exists rejected_at timestamptz;
update commands set accepted_at = coalesce(accepted_at, created_at), request_digest = coalesce(request_digest, repeat('0', 64)::sha256_digest) where status = 'accepted';
alter table commands add constraint commands_accept_reject_consistency check (
  (status = 'accepted' and accepted_at is not null and rejected_at is null)
  or (status = 'rejected' and rejected_at is not null and rejection is not null and accepted_at is null)
  or (status not in ('accepted','rejected'))
);

alter table events add column if not exists correlation_id text;
alter table events add column if not exists source_port_name text;
alter table events add constraint events_component_source_port_required check (source_kind <> 'component' or source_port_name is not null);
create table event_stream_sequences (stream_key text primary key, next_sequence_number bigint not null check(next_sequence_number > 0));

alter table deliveries add column if not exists correlation_id text;
update deliveries d set correlation_id = coalesce(d.correlation_id, c.correlation_id, e.correlation_id, d.id::text) from commands c full join events e on false where d.source_command_id = c.id or d.source_event_id = e.id;
alter table deliveries alter column correlation_id set not null;
alter table deliveries add column if not exists input_payload jsonb not null default '{}';
alter table deliveries add column if not exists input_payload_digest sha256_digest;
update deliveries set input_payload_digest = coalesce(input_payload_digest, repeat('0',64)::sha256_digest);
alter table deliveries alter column input_payload_digest set not null;
create unique index deliveries_command_source_target_unique on deliveries(source_command_id, topology_revision_id, target_component_instance_id, target_port_name) where source_command_id is not null;
create unique index deliveries_event_source_target_unique on deliveries(source_event_id, topology_revision_id, target_component_instance_id, target_port_name) where source_event_id is not null;
drop index if exists deliveries_ready_idx;
create index deliveries_scheduler_group_idx on deliveries(status, available_at, region_id, topology_revision_id, target_component_instance_id, correlation_id, created_at);

alter table executions add column if not exists input_set_digest sha256_digest;
update executions set input_set_digest = coalesce(input_set_digest, repeat('0',64)::sha256_digest);
alter table executions alter column input_set_digest set not null;
create unique index executions_logical_identity_unique on executions(region_id, component_instance_id, topology_revision_id, lifecycle_epoch, input_set_digest);
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
drop index if exists executions_logical_identity_unique;
alter table executions drop column if exists input_set_digest;
drop index if exists deliveries_scheduler_group_idx;
create index if not exists deliveries_ready_idx on deliveries(available_at, created_at) where status = 'ready';
drop index if exists deliveries_event_source_target_unique;
drop index if exists deliveries_command_source_target_unique;
alter table deliveries drop column if exists input_payload_digest;
alter table deliveries drop column if exists input_payload;
alter table deliveries drop column if exists correlation_id;
drop table if exists event_stream_sequences;
alter table events drop constraint if exists events_component_source_port_required;
alter table events drop column if exists source_port_name;
alter table events drop column if exists correlation_id;
alter table commands drop constraint if exists commands_accept_reject_consistency;
alter table commands drop column if exists rejected_at;
alter table commands drop column if exists accepted_at;
alter table commands drop column if exists rejection;
alter table commands drop column if exists request_digest;
alter table commands drop column if exists source;
`.execute(db);
}
