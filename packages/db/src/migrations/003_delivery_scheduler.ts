import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
alter table commands add column if not exists source jsonb not null default '{}';
alter table commands add column if not exists request_digest sha256_digest;
alter table commands add column if not exists rejection jsonb;
alter table commands add column if not exists accepted_at timestamptz default now();
alter table commands add column if not exists rejected_at timestamptz;
update commands
set request_digest = coalesce(
      request_digest,
      (md5(id::text) || md5('command:' || id::text))::sha256_digest
    ),
    accepted_at = case
      when status = 'accepted' then coalesce(accepted_at, created_at)
      else accepted_at
    end,
    rejected_at = case
      when status = 'rejected' then coalesce(rejected_at, created_at)
      else rejected_at
    end,
    rejection = case
      when status = 'rejected' then coalesce(rejection, '{"code":"legacy_rejection","message":"Rejected before structured rejection metadata was introduced"}'::jsonb)
      else rejection
    end;
alter table commands alter column request_digest set not null;
create or replace function ff_command_insert_defaults() returns trigger language plpgsql as $$
begin
  if new.request_digest is null then
    new.request_digest := (md5(new.id::text) || md5('command:' || new.id::text))::sha256_digest;
  end if;
  if new.correlation_id is null then
    new.correlation_id := new.id::text;
  end if;
  return new;
end
$$;
create trigger commands_insert_defaults
  before insert on commands
  for each row execute function ff_command_insert_defaults();
alter table commands add constraint commands_accept_reject_consistency check (
  (status = 'accepted' and accepted_at is not null and rejected_at is null and rejection is null)
  or (status = 'rejected' and rejected_at is not null and rejection is not null and accepted_at is null)
  or (status not in ('accepted','rejected'))
);

alter table events add column if not exists correlation_id text;
alter table events add column if not exists source_port_name text;
update events e
set correlation_id = coalesce(
  e.correlation_id,
  (select c.correlation_id from commands c where c.id = e.source_command_id),
  (select parent.correlation_id from events parent where parent.id = e.source_event_id),
  e.id::text
);
alter table events alter column correlation_id set not null;
create or replace function ff_event_insert_defaults() returns trigger language plpgsql as $$
begin
  if new.correlation_id is null then
    new.correlation_id := coalesce(
      (select c.correlation_id from commands c where c.id = new.source_command_id),
      (select parent.correlation_id from events parent where parent.id = new.source_event_id),
      new.id::text
    );
  end if;
  return new;
end
$$;
create trigger events_insert_defaults
  before insert on events
  for each row execute function ff_event_insert_defaults();
alter table events add constraint events_component_source_port_required
  check (source_kind <> 'component' or source_port_name is not null) not valid;
create table event_stream_sequences (
  stream_key text primary key,
  next_sequence_number bigint not null check(next_sequence_number > 0)
);
insert into event_stream_sequences(stream_key, next_sequence_number)
select stream_key, max(sequence_number) + 1
from events
group by stream_key;

alter table deliveries add column if not exists correlation_id text;
update deliveries d
set correlation_id = coalesce(
  d.correlation_id,
  (select c.correlation_id from commands c where c.id = d.source_command_id),
  (select e.correlation_id from events e where e.id = d.source_event_id),
  d.id::text
);
alter table deliveries alter column correlation_id set not null;
alter table deliveries add column if not exists input_payload jsonb not null default '{}';
update deliveries d
set input_payload = coalesce(
  (select c.payload from commands c where c.id = d.source_command_id),
  (select e.payload from events e where e.id = d.source_event_id),
  d.input_payload
);
alter table deliveries add column if not exists input_payload_digest sha256_digest;
update deliveries
set input_payload_digest = coalesce(
  input_payload_digest,
  (md5(id::text) || md5('delivery:' || id::text))::sha256_digest
);
alter table deliveries alter column input_payload_digest set not null;
create or replace function ff_delivery_insert_defaults() returns trigger language plpgsql as $$
begin
  new.correlation_id := coalesce(
    new.correlation_id,
    (select c.correlation_id from commands c where c.id = new.source_command_id),
    (select e.correlation_id from events e where e.id = new.source_event_id),
    new.id::text
  );
  new.input_payload := coalesce(
    (select c.payload from commands c where c.id = new.source_command_id),
    (select e.payload from events e where e.id = new.source_event_id),
    new.input_payload,
    '{}'::jsonb
  );
  if new.input_payload_digest is null then
    new.input_payload_digest := (md5(new.id::text) || md5('delivery:' || new.id::text))::sha256_digest;
  end if;
  return new;
end
$$;
create trigger deliveries_insert_defaults
  before insert on deliveries
  for each row execute function ff_delivery_insert_defaults();
create unique index deliveries_command_source_target_unique
  on deliveries(source_command_id, topology_revision_id, target_component_instance_id, target_port_name)
  where source_command_id is not null;
create unique index deliveries_event_source_target_unique
  on deliveries(source_event_id, topology_revision_id, target_component_instance_id, target_port_name)
  where source_event_id is not null;
drop index if exists deliveries_ready_idx;
create index deliveries_scheduler_group_idx
  on deliveries(status, available_at, region_id, topology_revision_id, target_component_instance_id, correlation_id, created_at);

alter table executions add column if not exists input_set_digest sha256_digest;
update executions
set input_set_digest = coalesce(
  input_set_digest,
  (md5(id::text) || md5('execution:' || id::text))::sha256_digest
);
alter table executions alter column input_set_digest set not null;
create or replace function ff_execution_insert_defaults() returns trigger language plpgsql as $$
begin
  if new.input_set_digest is null then
    new.input_set_digest := (md5(new.id::text) || md5('execution:' || new.id::text))::sha256_digest;
  end if;
  return new;
end
$$;
create trigger executions_insert_defaults
  before insert on executions
  for each row execute function ff_execution_insert_defaults();
create unique index executions_logical_identity_unique
  on executions(region_id, component_instance_id, topology_revision_id, lifecycle_epoch, input_set_digest);
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
drop index if exists executions_logical_identity_unique;
drop trigger if exists executions_insert_defaults on executions;
drop function if exists ff_execution_insert_defaults();
alter table executions drop column if exists input_set_digest;
drop index if exists deliveries_scheduler_group_idx;
create index if not exists deliveries_ready_idx on deliveries(available_at, created_at) where status = 'ready';
drop index if exists deliveries_event_source_target_unique;
drop index if exists deliveries_command_source_target_unique;
drop trigger if exists deliveries_insert_defaults on deliveries;
drop function if exists ff_delivery_insert_defaults();
alter table deliveries drop column if exists input_payload_digest;
alter table deliveries drop column if exists input_payload;
alter table deliveries drop column if exists correlation_id;
drop table if exists event_stream_sequences;
alter table events drop constraint if exists events_component_source_port_required;
drop trigger if exists events_insert_defaults on events;
drop function if exists ff_event_insert_defaults();
alter table events drop column if exists source_port_name;
alter table events drop column if exists correlation_id;
alter table commands drop constraint if exists commands_accept_reject_consistency;
drop trigger if exists commands_insert_defaults on commands;
drop function if exists ff_command_insert_defaults();
alter table commands drop column if exists rejected_at;
alter table commands drop column if exists accepted_at;
alter table commands drop column if exists rejection;
alter table commands drop column if exists request_digest;
alter table commands drop column if exists source;
`.execute(db);
}
