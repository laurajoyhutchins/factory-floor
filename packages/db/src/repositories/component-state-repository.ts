import { sql, type ColumnType, type Generated } from 'kysely';
import type { Json, RuntimeDb } from '../database.js';
import { createUuidV7 } from '../ids.js';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Jsonb = ColumnType<Json, Json, Json>;
type BigIntString = ColumnType<string, string, string>;

export interface ArtifactInlinePayloadTable {
  artifact_id: string;
  payload: Jsonb;
  canonical_size_bytes: BigIntString;
  created_at: Generated<Timestamp>;
}

export interface ComponentStateVersionTable {
  id: string;
  component_instance_id: string;
  state_port_name: string;
  version_number: number;
  artifact_id: string;
  schema_id: string;
  topology_revision_id: string;
  region_id: string;
  source_kind: 'template_instantiation' | 'execution';
  source_template_id: string | null;
  origin_template_instantiation_id: string | null;
  source_execution_id: string | null;
  source_attempt_id: string | null;
  provenance: Jsonb;
  created_at: Generated<Timestamp>;
}

export interface TemplateInstantiationStateLinkTable {
  template_instantiation_id: string;
  state_version_id: string;
  created_at: Generated<Timestamp>;
}

declare module '../database.js' {
  interface Database {
    artifact_inline_payloads: ArtifactInlinePayloadTable;
    component_state_versions: ComponentStateVersionTable;
    template_instantiation_state_links: TemplateInstantiationStateLinkTable;
  }
}

export interface CreateInitialStateVersionInput {
  componentInstanceId: string;
  statePortName: string;
  artifactId: string;
  schemaId: string;
  topologyRevisionId: string;
  regionId: string;
  sourceTemplateId: string;
  originTemplateInstantiationId: string;
  provenance: Json;
}

export class ComponentStateRepository {
  async createInlinePayloadIdempotently(
    db: RuntimeDb,
    input: { artifactId: string; payload: Json; canonicalSizeBytes: string },
  ) {
    const inserted = await db
      .insertInto('artifact_inline_payloads')
      .values({
        artifact_id: input.artifactId,
        payload: sql<Json>`${JSON.stringify(input.payload)}::jsonb`,
        canonical_size_bytes: input.canonicalSizeBytes,
      })
      .onConflict((conflict) => conflict.column('artifact_id').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return { payload: inserted, created: true as const };
    const existing = await db
      .selectFrom('artifact_inline_payloads')
      .selectAll()
      .where('artifact_id', '=', input.artifactId)
      .executeTakeFirstOrThrow();
    return { payload: existing, created: false as const };
  }

  async createInitialVersionIdempotently(
    db: RuntimeDb,
    input: CreateInitialStateVersionInput,
  ) {
    const inserted = await db
      .insertInto('component_state_versions')
      .values({
        id: createUuidV7(),
        component_instance_id: input.componentInstanceId,
        state_port_name: input.statePortName,
        version_number: 1,
        artifact_id: input.artifactId,
        schema_id: input.schemaId,
        topology_revision_id: input.topologyRevisionId,
        region_id: input.regionId,
        source_kind: 'template_instantiation',
        source_template_id: input.sourceTemplateId,
        origin_template_instantiation_id: input.originTemplateInstantiationId,
        source_execution_id: null,
        source_attempt_id: null,
        provenance: input.provenance,
      })
      .onConflict((conflict) =>
        conflict
          .columns([
            'component_instance_id',
            'state_port_name',
            'version_number',
          ])
          .doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    if (inserted) return { version: inserted, created: true as const };
    const existing = await db
      .selectFrom('component_state_versions')
      .selectAll()
      .where('component_instance_id', '=', input.componentInstanceId)
      .where('state_port_name', '=', input.statePortName)
      .where('version_number', '=', 1)
      .executeTakeFirstOrThrow();
    return { version: existing, created: false as const };
  }

  async linkInstantiationIdempotently(
    db: RuntimeDb,
    templateInstantiationId: string,
    stateVersionId: string,
  ) {
    return db
      .insertInto('template_instantiation_state_links')
      .values({
        template_instantiation_id: templateInstantiationId,
        state_version_id: stateVersionId,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['template_instantiation_id', 'state_version_id'])
          .doNothing(),
      )
      .execute();
  }

  readLatestState(db: RuntimeDb, componentInstanceId: string) {
    return db
      .selectFrom('component_state_versions as state')
      .innerJoin('artifacts as artifact', 'artifact.id', 'state.artifact_id')
      .innerJoin('artifact_schemas as schema', 'schema.id', 'state.schema_id')
      .leftJoin(
        'artifact_inline_payloads as inline',
        'inline.artifact_id',
        'artifact.id',
      )
      .select([
        'state.id as state_version_id',
        'state.state_port_name',
        'state.version_number',
        'state.provenance',
        'artifact.id as artifact_id',
        'artifact.digest',
        'artifact.size_bytes',
        'artifact.media_type',
        'artifact.committed_locator',
        'artifact.state as artifact_state',
        'schema.id as schema_id',
        'schema.content_digest as schema_digest',
        'inline.payload as inline_payload',
      ])
      .where('state.component_instance_id', '=', componentInstanceId)
      .where('artifact.state', '=', 'committed')
      .orderBy('state.version_number', 'desc')
      .orderBy('state.created_at', 'desc')
      .executeTakeFirst();
  }
}
