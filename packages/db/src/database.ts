import {
  Kysely,
  PostgresDialect,
  type ColumnType,
  type Generated,
  type Transaction,
} from 'kysely';
import pg from 'pg';

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type RuntimeDb = Kysely<Database> | Transaction<Database>;

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Jsonb = ColumnType<Json, Json, Json>;
type BigIntString = ColumnType<string, string, string>;

type Row = { id: string; created_at: Generated<Timestamp> };
type Versioned = Row & {
  name: string;
  version: string;
  content_digest: string;
  retired_at: Timestamp | null;
};

export interface Database {
  artifact_schemas: Versioned & { schema: Jsonb };
  component_definitions: Versioned & { definition: Jsonb };
  port_definitions: Row & {
    component_definition_id: string;
    name: string;
    direction: 'input' | 'output' | 'state';
    schema_id: string;
    required: boolean;
  };
  templates: Versioned & { template: Jsonb };
  policies: Versioned & { policy: Jsonb };
  regions: Row & {
    parent_region_id: string | null;
    name: string;
    lifecycle_status: Generated<string>;
    lifecycle_epoch: Generated<number>;
    active_topology_revision_id: string | null;
  };
  topology_revisions: Row & {
    region_id: string;
    revision_number: number;
    content_digest: string;
    topology: Jsonb;
    activated_at: Timestamp | null;
  };
  component_instances: Row & {
    region_id: string;
    topology_revision_id: string;
    component_definition_id: string;
    name: string;
    configuration: Jsonb;
    lifecycle_status: Generated<string>;
  };
  connections: Row & {
    topology_revision_id: string;
    source_component_instance_id: string;
    source_port_name: string;
    target_component_instance_id: string;
    target_port_name: string;
  };
  commands: Row & {
    region_id: string;
    command_type: string;
    payload: Jsonb;
    status: Generated<string>;
    correlation_id: string | null;
    idempotency_key: string | null;
    expires_at: Timestamp | null;
  };
  events: Row & {
    region_id: string;
    event_type: string;
    payload: Jsonb;
    stream_key: string;
    sequence_number: BigIntString;
    command_id: string | null;
    source_kind: string;
    source_command_id: string | null;
    source_event_id: string | null;
    source_execution_id: string | null;
    source_attempt_id: string | null;
    source_component_instance_id: string | null;
  };
  deliveries: Row & {
    region_id: string;
    topology_revision_id: string;
    target_component_instance_id: string;
    target_port_name: string;
    source_command_id: string | null;
    source_event_id: string | null;
    status: Generated<string>;
    available_at: Generated<Timestamp>;
    lease_owner: string | null;
    lease_token: string | null;
    lease_expires_at: Timestamp | null;
    attempts_count: Generated<number>;
  };
  executions: Row & {
    delivery_id: string;
    region_id: string;
    component_instance_id: string;
    topology_revision_id: string;
    lifecycle_epoch: Generated<number>;
    status: Generated<string>;
    completed_at: Timestamp | null;
    failed_at: Timestamp | null;
    failure: Jsonb | null;
  };
  execution_attempts: Row & {
    execution_id: string;
    attempt_number: number;
    status: string;
    lease_owner: string | null;
    lease_token: string | null;
    lease_expires_at: Timestamp | null;
    started_at: Timestamp | null;
    completed_at: Timestamp | null;
    failure: Jsonb | null;
  };
  execution_inputs: Row & {
    execution_id: string;
    port_name: string;
    artifact_id: string | null;
    delivery_id: string;
    payload: Jsonb | null;
  };
  execution_outputs: Row & {
    execution_id: string;
    attempt_id: string;
    port_name: string;
    artifact_id: string;
    published_event_id: string | null;
  };
  artifacts: Row & {
    digest_algorithm: 'sha256';
    digest: string;
    size_bytes: BigIntString;
    schema_id: string;
    state: string;
    media_type: string;
    committed_locator: string | null;
    provenance: Jsonb;
    tombstoned_at: Timestamp | null;
  };
  artifact_derivations: Row & {
    artifact_id: string;
    source_artifact_id: string | null;
    execution_id: string | null;
    attempt_id: string | null;
    derivation_type: string;
  };
  artifact_staging: Row & {
    attempt_id: string;
    staged_ref: string;
    digest_algorithm: 'sha256';
    digest: string;
    size_bytes: BigIntString;
    schema_id: string;
    media_type: string;
    locator: string;
    status: string;
    metadata: Jsonb;
    artifact_id: string | null;
    promoted_at: Timestamp | null;
    abandoned_at: Timestamp | null;
  };
  capabilities: Versioned & { capability_type: string; configuration: Jsonb };
  capability_grants: Row & {
    capability_id: string;
    grantee_component_definition_id: string;
    status: string;
    granted_at: Timestamp;
    revoked_at: Timestamp | null;
  };
  policy_decisions: Row & {
    policy_id: string | null;
    policy_name: string;
    policy_version: string;
    evaluator_version: string;
    subject_kind: string;
    subject_id: string;
    input_artifact_id: string | null;
    normalized_inputs: Jsonb;
    outcome: string;
    reason: string | null;
    modifications: Jsonb;
  };
  approvals: Row & {
    policy_decision_id: string;
    status: string;
    requested_at: Timestamp;
    decided_at: Timestamp | null;
    decided_by: string | null;
  };
  external_actions: Row & {
    execution_id: string;
    attempt_id: string;
    capability_grant_id: string;
    outbound_request_artifact_id: string;
    policy_decision_id: string | null;
    approval_id: string | null;
    action_type: string;
    status: string;
    idempotency_key: string;
  };
  external_action_attempts: Row & {
    external_action_id: string;
    attempt_number: number;
    status: string;
    requested_at: Timestamp;
    completed_at: Timestamp | null;
    response: Jsonb | null;
  };
  resource_ledger: Row & {
    region_id: string;
    execution_id: string | null;
    attempt_id: string | null;
    external_action_id: string | null;
    resource_type: string;
    quantity: BigIntString;
    unit: string;
    attributes: Jsonb;
  };
  projection_checkpoints: Row & {
    projection_name: string;
    stream_key: string;
    last_event_id: string | null;
    last_sequence_number: BigIntString;
    updated_at: Timestamp;
  };
}

export function createDatabase(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
}
