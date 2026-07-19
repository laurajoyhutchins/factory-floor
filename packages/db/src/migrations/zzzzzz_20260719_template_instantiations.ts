import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table template_instantiations (
      id uuid primary key,
      request_id uuid not null unique,
      request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
      target_region_id uuid not null references regions(id) on delete restrict,
      topology_revision_id uuid not null references topology_revisions(id) on delete restrict,
      template_id uuid not null references templates(id) on delete restrict,
      effective_digest char(64) not null check (effective_digest ~ '^[a-f0-9]{64}$'),
      parameters jsonb not null check (jsonb_typeof(parameters) = 'object'),
      component_configuration jsonb not null check (jsonb_typeof(component_configuration) = 'object'),
      source jsonb not null check (jsonb_typeof(source) = 'object'),
      referenced_definitions jsonb not null check (jsonb_typeof(referenced_definitions) = 'array'),
      initial_disposition text not null check (initial_disposition in ('created', 'existing')),
      created_at timestamptz not null default now()
    );

    create index template_instantiations_target_region_created_idx
      on template_instantiations (target_region_id, created_at, id);
    create index template_instantiations_topology_revision_idx
      on template_instantiations (topology_revision_id);
    create index template_instantiations_template_idx
      on template_instantiations (template_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists template_instantiations`.execute(db);
}
