import { createHash } from 'node:crypto';
import type { Database, Json } from '@factory-floor/db';
import type { Kysely } from 'kysely';

export interface TemplateInstantiationInspectionScope {
  regionId?: string;
  runId?: string;
}

export interface TemplateInstantiationInspectionPageRequest {
  cursor?: string;
  limit?: number;
}

export interface TemplateInstantiationSummary {
  id: string;
  requestId: string;
  requestDigest: string;
  effectiveDigest: string;
  disposition: 'created' | 'existing';
  targetRegion: {
    id: string;
    name: string;
  };
  topologyRevision: {
    id: string;
    revisionNumber: number;
    digest: string;
  };
  template: {
    id: string;
    name: string;
    version: string;
    digest: string;
  };
  createdAt: Date;
}

export interface TemplateInstantiationInitialStateInspection {
  stateVersionId: string;
  versionNumber: number;
  owner: {
    componentInstanceId: string;
    componentName: string;
    portName: string;
  };
  schema: {
    id: string;
    name: string;
    version: string;
    digest: string;
  };
  artifact: {
    id: string;
    digestAlgorithm: 'sha256';
    digest: string;
    sizeBytes: string;
    mediaType: string;
    state: string;
  };
  value: Json | null;
  canonicalSizeBytes: string | null;
  source:
    | {
        kind: 'templateInstantiation';
        instantiationId: string;
        templateId: string;
        regionId: string;
      }
    | {
        kind: 'execution';
        executionId: string;
        attemptId: string;
        regionId: string;
      };
  provenance: Json;
  createdAt: Date;
}

export interface TemplateInstantiationDetail extends TemplateInstantiationSummary {
  parameters: Json;
  componentConfiguration: Json;
  source: Json;
  referencedDefinitions: Json;
  initialStates: TemplateInstantiationInitialStateInspection[];
}

export interface TemplateInstantiationInspectionPage {
  items: TemplateInstantiationSummary[];
  nextCursor: string | null;
}

type Cursor = {
  v: 1;
  scopeDigest: string;
  afterCreatedAt: string;
  afterId: string;
};

type NormalizedScope = {
  kind: 'region' | 'run';
  id: string;
  digest: string;
};

type SummaryRow = {
  id: string;
  request_id: string;
  request_digest: string;
  effective_digest: string;
  initial_disposition: 'created' | 'existing';
  target_region_id: string;
  region_name: string;
  topology_revision_id: string;
  revision_number: number;
  topology_digest: string;
  template_id: string;
  template_name: string;
  template_version: string;
  template_digest: string;
  created_at: Date;
};

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('invalid_limit');
  return limit;
}

function normalizeScope(
  scope: TemplateInstantiationInspectionScope,
): NormalizedScope {
  const regionId = scope.regionId?.trim();
  const runId = scope.runId?.trim();
  if ((regionId ? 1 : 0) + (runId ? 1 : 0) !== 1)
    throw new Error('invalid_scope');
  const kind = regionId ? 'region' : 'run';
  const id = regionId ?? runId!;
  return {
    kind,
    id,
    digest: createHash('sha256').update(`${kind}:${id}`).digest('hex'),
  };
}

function decodeCursor(value: string | undefined, scopeDigest: string) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<Cursor>;
    const timestamp = new Date(parsed.afterCreatedAt ?? '');
    if (
      parsed.v !== 1 ||
      parsed.scopeDigest !== scopeDigest ||
      typeof parsed.afterId !== 'string' ||
      parsed.afterId.length === 0 ||
      Number.isNaN(timestamp.getTime())
    )
      throw new Error('invalid cursor');
    return { afterCreatedAt: timestamp, afterId: parsed.afterId };
  } catch {
    throw new Error('invalid_cursor');
  }
}

function encodeCursor(scopeDigest: string, row: SummaryRow): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      scopeDigest,
      afterCreatedAt: row.created_at.toISOString(),
      afterId: row.id,
    } satisfies Cursor),
    'utf8',
  ).toString('base64url');
}

function toSummary(row: SummaryRow): TemplateInstantiationSummary {
  return {
    id: row.id,
    requestId: row.request_id,
    requestDigest: row.request_digest,
    effectiveDigest: row.effective_digest,
    disposition: row.initial_disposition,
    targetRegion: { id: row.target_region_id, name: row.region_name },
    topologyRevision: {
      id: row.topology_revision_id,
      revisionNumber: row.revision_number,
      digest: row.topology_digest,
    },
    template: {
      id: row.template_id,
      name: row.template_name,
      version: row.template_version,
      digest: row.template_digest,
    },
    createdAt: row.created_at,
  };
}

export class TemplateInstantiationInspectionService {
  constructor(private readonly db: Kysely<Database>) {}

  async list(
    scopeInput: TemplateInstantiationInspectionScope,
    page: TemplateInstantiationInspectionPageRequest = {},
  ): Promise<TemplateInstantiationInspectionPage> {
    const scope = normalizeScope(scopeInput);
    const limit = normalizeLimit(page.limit);
    const cursor = decodeCursor(page.cursor, scope.digest);
    const revisionIds =
      scope.kind === 'run' ? await this.runTopologyRevisionIds(scope.id) : null;
    if (revisionIds !== null && revisionIds.length === 0)
      return { items: [], nextCursor: null };

    let query = this.summaryQuery().limit(limit + 1);
    if (scope.kind === 'region')
      query = query.where('instantiation.target_region_id', '=', scope.id);
    else
      query = query.where(
        'instantiation.topology_revision_id',
        'in',
        revisionIds!,
      );
    if (cursor)
      query = query.where((eb) =>
        eb.or([
          eb('instantiation.created_at', '>', cursor.afterCreatedAt),
          eb.and([
            eb('instantiation.created_at', '=', cursor.afterCreatedAt),
            eb('instantiation.id', '>', cursor.afterId),
          ]),
        ]),
      );

    const rows = await query
      .orderBy('instantiation.created_at')
      .orderBy('instantiation.id')
      .execute();
    const selected = rows.slice(0, limit) as SummaryRow[];
    return {
      items: selected.map(toSummary),
      nextCursor:
        rows.length > limit
          ? encodeCursor(scope.digest, selected.at(-1)!)
          : null,
    };
  }

  async get(id: string): Promise<TemplateInstantiationDetail | null> {
    const row = await this.summaryQuery()
      .select([
        'instantiation.parameters',
        'instantiation.component_configuration',
        'instantiation.source',
        'instantiation.referenced_definitions',
      ])
      .where('instantiation.id', '=', id)
      .executeTakeFirst();
    if (!row) return null;
    return {
      ...toSummary(row as SummaryRow),
      parameters: row.parameters,
      componentConfiguration: row.component_configuration,
      source: row.source,
      referencedDefinitions: row.referenced_definitions,
      initialStates: await this.initialStates(id),
    };
  }

  async listForTopologyRevision(
    topologyRevisionId: string,
  ): Promise<TemplateInstantiationSummary[]> {
    const rows = await this.summaryQuery()
      .where('instantiation.topology_revision_id', '=', topologyRevisionId)
      .orderBy('instantiation.created_at')
      .orderBy('instantiation.id')
      .limit(100)
      .execute();
    return (rows as SummaryRow[]).map(toSummary);
  }

  async forArtifact(
    artifactId: string,
  ): Promise<TemplateInstantiationSummary[]> {
    const links = await this.db
      .selectFrom('template_instantiation_state_links as link')
      .innerJoin(
        'component_state_versions as state',
        'state.id',
        'link.state_version_id',
      )
      .select('link.template_instantiation_id')
      .distinct()
      .where('state.artifact_id', '=', artifactId)
      .execute();
    const ids = links.map((link) => link.template_instantiation_id);
    if (ids.length === 0) return [];
    const rows = await this.summaryQuery()
      .where('instantiation.id', 'in', ids)
      .orderBy('instantiation.created_at')
      .orderBy('instantiation.id')
      .limit(100)
      .execute();
    return (rows as SummaryRow[]).map(toSummary);
  }

  private summaryQuery() {
    return this.db
      .selectFrom('template_instantiations as instantiation')
      .innerJoin(
        'regions as region',
        'region.id',
        'instantiation.target_region_id',
      )
      .innerJoin(
        'topology_revisions as revision',
        'revision.id',
        'instantiation.topology_revision_id',
      )
      .innerJoin(
        'templates as template',
        'template.id',
        'instantiation.template_id',
      )
      .select([
        'instantiation.id',
        'instantiation.request_id',
        'instantiation.request_digest',
        'instantiation.effective_digest',
        'instantiation.initial_disposition',
        'instantiation.target_region_id',
        'region.name as region_name',
        'instantiation.topology_revision_id',
        'revision.revision_number',
        'revision.content_digest as topology_digest',
        'instantiation.template_id',
        'template.name as template_name',
        'template.version as template_version',
        'template.content_digest as template_digest',
        'instantiation.created_at',
      ]);
  }

  private async runTopologyRevisionIds(runId: string): Promise<string[]> {
    const run = await this.db
      .selectFrom('commands')
      .select(['region_id', 'correlation_id'])
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run) throw new Error('run_not_found');
    if (!run.correlation_id) return [];
    const rows = await this.db
      .selectFrom('deliveries as delivery')
      .select('delivery.topology_revision_id')
      .distinct()
      .where('delivery.region_id', '=', run.region_id)
      .where('delivery.correlation_id', '=', run.correlation_id)
      .orderBy('delivery.topology_revision_id')
      .execute();
    return rows.map((row) => row.topology_revision_id);
  }

  private async initialStates(
    instantiationId: string,
  ): Promise<TemplateInstantiationInitialStateInspection[]> {
    const rows = await this.db
      .selectFrom('template_instantiation_state_links as link')
      .innerJoin(
        'component_state_versions as state',
        'state.id',
        'link.state_version_id',
      )
      .innerJoin(
        'component_instances as component',
        'component.id',
        'state.component_instance_id',
      )
      .innerJoin('artifact_schemas as schema', 'schema.id', 'state.schema_id')
      .innerJoin('artifacts as artifact', 'artifact.id', 'state.artifact_id')
      .leftJoin(
        'artifact_inline_payloads as inline',
        'inline.artifact_id',
        'artifact.id',
      )
      .select([
        'state.id as state_version_id',
        'state.version_number',
        'state.state_port_name',
        'state.region_id',
        'state.source_kind',
        'state.source_template_id',
        'state.origin_template_instantiation_id',
        'state.source_execution_id',
        'state.source_attempt_id',
        'state.provenance',
        'state.created_at',
        'component.id as component_instance_id',
        'component.name as component_name',
        'schema.id as schema_id',
        'schema.name as schema_name',
        'schema.version as schema_version',
        'schema.content_digest as schema_digest',
        'artifact.id as artifact_id',
        'artifact.digest_algorithm',
        'artifact.digest',
        'artifact.size_bytes',
        'artifact.media_type',
        'artifact.state as artifact_state',
        'inline.payload as inline_payload',
        'inline.canonical_size_bytes',
      ])
      .where('link.template_instantiation_id', '=', instantiationId)
      .orderBy('component.name')
      .orderBy('state.state_port_name')
      .orderBy('state.version_number')
      .orderBy('state.id')
      .execute();

    return rows.map((row) => {
      const source =
        row.source_kind === 'template_instantiation'
          ? {
              kind: 'templateInstantiation' as const,
              instantiationId: row.origin_template_instantiation_id!,
              templateId: row.source_template_id!,
              regionId: row.region_id,
            }
          : {
              kind: 'execution' as const,
              executionId: row.source_execution_id!,
              attemptId: row.source_attempt_id!,
              regionId: row.region_id,
            };
      return {
        stateVersionId: row.state_version_id,
        versionNumber: row.version_number,
        owner: {
          componentInstanceId: row.component_instance_id,
          componentName: row.component_name,
          portName: row.state_port_name,
        },
        schema: {
          id: row.schema_id,
          name: row.schema_name,
          version: row.schema_version,
          digest: row.schema_digest,
        },
        artifact: {
          id: row.artifact_id,
          digestAlgorithm: row.digest_algorithm,
          digest: row.digest,
          sizeBytes: row.size_bytes,
          mediaType: row.media_type,
          state: row.artifact_state,
        },
        value: row.inline_payload,
        canonicalSizeBytes: row.canonical_size_bytes,
        source,
        provenance: row.provenance,
        createdAt: row.created_at,
      };
    });
  }
}
