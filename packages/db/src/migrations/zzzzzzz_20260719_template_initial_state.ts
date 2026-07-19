import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table artifact_inline_payloads (
      artifact_id uuid primary key references artifacts(id) on delete cascade,
      payload jsonb not null,
      canonical_size_bytes bigint not null check (canonical_size_bytes >= 0),
      created_at timestamptz not null default now()
    );

    create table component_state_versions (
      id uuid primary key,
      component_instance_id uuid not null references component_instances(id) on delete restrict,
      state_port_name text not null check (length(btrim(state_port_name)) > 0),
      version_number integer not null check (version_number > 0),
      artifact_id uuid not null references artifacts(id) on delete restrict,
      schema_id uuid not null references artifact_schemas(id) on delete restrict,
      topology_revision_id uuid not null references topology_revisions(id) on delete restrict,
      region_id uuid not null references regions(id) on delete restrict,
      source_kind text not null check (source_kind in ('template_instantiation', 'execution')),
      source_template_id uuid references templates(id) on delete restrict,
      origin_template_instantiation_id uuid references template_instantiations(id) on delete restrict,
      source_execution_id uuid references executions(id) on delete restrict,
      source_attempt_id uuid references execution_attempts(id) on delete restrict,
      provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
      created_at timestamptz not null default now(),
      unique (component_instance_id, state_port_name, version_number),
      check (
        (source_kind = 'template_instantiation'
          and source_template_id is not null
          and origin_template_instantiation_id is not null
          and source_execution_id is null
          and source_attempt_id is null)
        or
        (source_kind = 'execution'
          and source_template_id is null
          and origin_template_instantiation_id is null
          and source_execution_id is not null
          and source_attempt_id is not null)
      )
    );

    create table template_instantiation_state_links (
      template_instantiation_id uuid not null references template_instantiations(id) on delete restrict,
      state_version_id uuid not null references component_state_versions(id) on delete restrict,
      created_at timestamptz not null default now(),
      primary key (template_instantiation_id, state_version_id)
    );

    create index component_state_versions_latest_idx
      on component_state_versions (component_instance_id, version_number desc);
    create index component_state_versions_artifact_idx
      on component_state_versions (artifact_id);
    create index component_state_versions_origin_instantiation_idx
      on component_state_versions (origin_template_instantiation_id)
      where origin_template_instantiation_id is not null;
    create index component_state_versions_source_execution_idx
      on component_state_versions (source_execution_id)
      where source_execution_id is not null;
    create index template_instantiation_state_links_version_idx
      on template_instantiation_state_links (state_version_id);

    create function record_execution_component_state_version()
    returns trigger
    language plpgsql
    as $$
    declare
      owner_component_id uuid;
      owner_topology_revision_id uuid;
      owner_region_id uuid;
      artifact_schema_id uuid;
      next_version integer;
    begin
      if new.published_event_id is not null then
        return new;
      end if;

      select
        execution.component_instance_id,
        execution.topology_revision_id,
        execution.region_id,
        artifact.schema_id
      into
        owner_component_id,
        owner_topology_revision_id,
        owner_region_id,
        artifact_schema_id
      from executions as execution
      join artifacts as artifact on artifact.id = new.artifact_id
      where execution.id = new.execution_id;

      if not exists (
        select 1
        from component_instances as component
        join port_definitions as port
          on port.component_definition_id = component.component_definition_id
        where component.id = owner_component_id
          and port.direction = 'state'
          and port.name = new.port_name
          and port.schema_id = artifact_schema_id
      ) then
        raise exception 'execution output % is not an authoritative component state artifact', new.id;
      end if;

      select coalesce(max(version_number), 0) + 1
      into next_version
      from component_state_versions
      where component_instance_id = owner_component_id;

      insert into component_state_versions (
        id,
        component_instance_id,
        state_port_name,
        version_number,
        artifact_id,
        schema_id,
        topology_revision_id,
        region_id,
        source_kind,
        source_template_id,
        origin_template_instantiation_id,
        source_execution_id,
        source_attempt_id,
        provenance
      ) values (
        gen_random_uuid(),
        owner_component_id,
        new.port_name,
        next_version,
        new.artifact_id,
        artifact_schema_id,
        owner_topology_revision_id,
        owner_region_id,
        'execution',
        null,
        null,
        new.execution_id,
        new.attempt_id,
        jsonb_build_object(
          'kind', 'execution',
          'executionId', new.execution_id,
          'attemptId', new.attempt_id
        )
      );

      return new;
    end;
    $$;

    create trigger execution_output_records_component_state_version
    after insert on execution_outputs
    for each row
    execute function record_execution_component_state_version();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop trigger if exists execution_output_records_component_state_version on execution_outputs;
    drop function if exists record_execution_component_state_version();
    drop table if exists template_instantiation_state_links;
    drop table if exists component_state_versions;
    drop table if exists artifact_inline_payloads;
  `.execute(db);
}
