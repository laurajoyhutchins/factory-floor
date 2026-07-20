import { createUuidV7, type Database } from '@factory-floor/db';
import { sql, type Kysely } from 'kysely';
import {
  ObservabilityService as BaseObservabilityService,
  PROJECTION_NAMES as BASE_PROJECTION_NAMES,
} from '../observability/observability-service.js';
import {
  TemplateInstantiationInspectionService,
  type TemplateInstantiationInspectionPageRequest,
  type TemplateInstantiationInspectionScope,
} from './template-instantiation-inspection-service.js';

export const PROJECTION_NAMES = [
  ...BASE_PROJECTION_NAMES,
  'template-instantiation-history',
] as const;
export type ProjectionName = (typeof PROJECTION_NAMES)[number];
const PROJECTOR_VERSION = 'task10.template-instantiation.v1';

export class ObservabilityService extends BaseObservabilityService {
  private readonly instantiations: TemplateInstantiationInspectionService;

  constructor(private readonly inspectionDb: Kysely<Database>) {
    super(inspectionDb);
    this.instantiations = new TemplateInstantiationInspectionService(
      inspectionDb,
    );
  }

  listTemplateInstantiations(
    scope: TemplateInstantiationInspectionScope,
    page: TemplateInstantiationInspectionPageRequest = {},
  ) {
    return this.instantiations.list(scope, page);
  }

  templateInstantiation(id: string) {
    return this.instantiations.get(id);
  }

  override async executionTrace(id: string) {
    const trace = await super.executionTrace(id);
    if (!trace) return null;
    return {
      ...trace,
      templateInstantiations:
        await this.instantiations.listForTopologyRevision(
          trace.execution.topology_revision_id,
        ),
    };
  }

  override async artifactLineage(artifactId: string) {
    const lineage = await super.artifactLineage(artifactId);
    if (!lineage) return null;
    return {
      ...lineage,
      templateInstantiations: await this.instantiations.forArtifact(artifactId),
    };
  }

  override async projectionStatus(): ReturnType<
    BaseObservabilityService['projectionStatus']
  > {
    const base = await super.projectionStatus();
    const checkpoint = await this.inspectionDb
      .selectFrom('projection_checkpoints')
      .selectAll()
      .where('projection_name', '=', 'template-instantiation-history')
      .where('stream_key', '=', 'global')
      .executeTakeFirst();
    const now = Date.now();
    const extra = {
      projectionName: 'template-instantiation-history',
      streamKey: 'global',
      checkpointId: checkpoint?.id ?? null,
      lastEventId: checkpoint?.last_event_id ?? null,
      lastSequenceNumber: checkpoint?.last_sequence_number ?? '0',
      updatedAt: checkpoint?.updated_at ?? null,
      stalenessMs: checkpoint
        ? Math.max(0, now - new Date(checkpoint.updated_at).getTime())
        : null,
      projectorVersion: PROJECTOR_VERSION,
      snapshot: await this.templateInstantiationSnapshot(),
    } as unknown as (typeof base)[number];
    return [...base, extra];
  }

  override async rebuildProjections(batchSize = 500) {
    const result = await super.rebuildProjections(batchSize);
    const rebuiltAt = new Date();
    await this.inspectionDb
      .insertInto('projection_checkpoints')
      .values({
        id: createUuidV7(),
        projection_name: 'template-instantiation-history',
        stream_key: 'global',
        last_event_id: result.processedThroughEventId,
        last_sequence_number: String(result.processedEvents),
        updated_at: rebuiltAt,
      })
      .onConflict((conflict) =>
        conflict.columns(['projection_name', 'stream_key']).doUpdateSet({
          last_event_id: result.processedThroughEventId,
          last_sequence_number: String(result.processedEvents),
          updated_at: rebuiltAt,
        }),
      )
      .execute();
    return result;
  }

  private async templateInstantiationSnapshot() {
    const result = await sql<{
      instantiations: string;
      seeded_state_versions: string;
      first_created_at: Date | null;
      latest_created_at: Date | null;
    }>`
      select
        (select count(*) from template_instantiations)::text as instantiations,
        (select count(*) from component_state_versions where source_kind = 'template_instantiation')::text as seeded_state_versions,
        (select min(created_at) from template_instantiations) as first_created_at,
        (select max(created_at) from template_instantiations) as latest_created_at
    `.execute(this.inspectionDb);
    const row = result.rows[0];
    return {
      instantiations: Number(row.instantiations),
      seededStateVersions: Number(row.seeded_state_versions),
      firstCreatedAt: row.first_created_at,
      latestCreatedAt: row.latest_created_at,
    };
  }
}
