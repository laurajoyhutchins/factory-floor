import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
create table resource_budgets (
  id uuid primary key,
  scope_kind text not null check (scope_kind in ('installation', 'region', 'component', 'capability', 'external_action', 'worker_pool')),
  scope_id text not null,
  parent_budget_id uuid references resource_budgets(id),
  resource_type text not null,
  limit_quantity bigint not null check (limit_quantity >= 0),
  unit text not null,
  exhaustion_outcome text not null default 'defer'
    check (exhaustion_outcome in ('defer', 'require_approval', 'suspend', 'reject')),
  source jsonb not null default '{}',
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
create unique index resource_budgets_active_scope_resource_unique
  on resource_budgets(scope_kind, scope_id, resource_type)
  where retired_at is null;
create index resource_budgets_parent_idx on resource_budgets(parent_budget_id)
  where parent_budget_id is not null;

create table resource_reservations (
  id uuid primary key,
  budget_id uuid not null references resource_budgets(id),
  region_id uuid not null references regions(id),
  execution_id uuid references executions(id),
  attempt_id uuid references execution_attempts(id),
  external_action_id uuid references external_actions(id),
  idempotency_key text not null,
  quantity bigint not null check (quantity >= 0),
  actual_quantity bigint check (actual_quantity is null or actual_quantity >= 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'reconciled', 'released')),
  attributes jsonb not null default '{}',
  reserved_at timestamptz not null default now(),
  reconciled_at timestamptz
);
create unique index resource_reservations_budget_idempotency_unique
  on resource_reservations(budget_id, idempotency_key);
create index resource_reservations_active_budget_idx
  on resource_reservations(budget_id, status)
  where status = 'reserved';
create index resource_reservations_region_idx on resource_reservations(region_id, reserved_at);

create table admission_decisions (
  id uuid primary key,
  subject_kind text not null,
  subject_id text not null,
  budget_id uuid references resource_budgets(id),
  resource_type text not null,
  outcome text not null
    check (outcome in ('admit', 'defer', 'require_approval', 'suspend', 'reject')),
  reason text not null,
  requested_quantity bigint not null check (requested_quantity >= 0),
  remaining_before bigint,
  reservation_id uuid references resource_reservations(id),
  created_at timestamptz not null default now()
);
create index admission_decisions_subject_idx
  on admission_decisions(subject_kind, subject_id, created_at desc);
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
drop table if exists admission_decisions;
drop table if exists resource_reservations;
drop table if exists resource_budgets;
`.execute(db);
}
