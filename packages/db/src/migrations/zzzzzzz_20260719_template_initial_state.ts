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
      source_template_id uuid not null references templates(id) on delete restrict,
      origin_template_instantiation_id uuid not null references template_instantiations(id) on delete restrict,
      provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
      created_at timestamptz not null default now(),
      unique (component_instance_id, state_port_name, version_number)
    );

    create table template_instantiation_state_links (
      template_instantiation_id uuid not null references template_instantiations(id) on delete restrict,
      state_version_id uuid not null references component_state_versions(id) on delete restrict,
      created_at timestamptz not null default now(),
      primary key (template_instantiation_id, state_version_id)
    );

    create index component_state_versions_latest_idx
      on component_state_versions (component_instance_id, state_port_name, version_number desc);
    create index component_state_versions_artifact_idx
      on component_state_versions (artifact_id);
    create index component_state_versions_origin_instantiation_idx
      on component_state_versions (origin_template_instantiation_id);
    create index template_instantiation_state_links_version_idx
      on template_instantiation_state_links (state_version_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists template_instantiation_state_links;
    drop table if exists component_state_versions;
    drop table if exists artifact_inline_payloads;
  `.execute(db);
}
