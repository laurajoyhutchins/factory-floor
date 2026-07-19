import { sql, type ColumnType, type Generated } from 'kysely';
import type { Json, RuntimeDb } from '../database.js';
import { createUuidV7 } from '../ids.js';

export type TemplateInstantiationDisposition = 'created' | 'existing';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Jsonb = ColumnType<Json, Json, Json>;

export interface TemplateInstantiationTable {
  id: string;
  request_id: string;
  request_digest: string;
  target_region_id: string;
  topology_revision_id: string;
  template_id: string;
  effective_digest: string;
  parameters: Jsonb;
  component_configuration: Jsonb;
  source: Jsonb;
  referenced_definitions: Jsonb;
  initial_disposition: TemplateInstantiationDisposition;
  created_at: Generated<Timestamp>;
}

declare module '../database.js' {
  interface Database {
    template_instantiations: TemplateInstantiationTable;
  }
}

export interface CreateTemplateInstantiationInput {
  requestId: string;
  requestDigest: string;
  targetRegionId: string;
  topologyRevisionId: string;
  templateId: string;
  effectiveDigest: string;
  parameters: Json;
  componentConfiguration: Json;
  source: Json;
  referencedDefinitions: Json;
  initialDisposition: TemplateInstantiationDisposition;
}

export class TemplateInstantiationRepository {
  findByRequestId(db: RuntimeDb, requestId: string) {
    return db
      .selectFrom('template_instantiations')
      .selectAll()
      .where('request_id', '=', requestId)
      .executeTakeFirst();
  }

  create(db: RuntimeDb, input: CreateTemplateInstantiationInput) {
    return db
      .insertInto('template_instantiations')
      .values({
        id: createUuidV7(),
        request_id: input.requestId,
        request_digest: input.requestDigest,
        target_region_id: input.targetRegionId,
        topology_revision_id: input.topologyRevisionId,
        template_id: input.templateId,
        effective_digest: input.effectiveDigest,
        parameters: input.parameters,
        component_configuration: input.componentConfiguration,
        source: input.source,
        referenced_definitions: sql<Json>`${JSON.stringify(
          input.referencedDefinitions,
        )}::jsonb`,
        initial_disposition: input.initialDisposition,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
