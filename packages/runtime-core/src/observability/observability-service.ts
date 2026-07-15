import type { Database } from '@factory-floor/db';
import { createUuidV7 } from '@factory-floor/db';
import { sql, type Kysely } from 'kysely';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const PROJECTION_NAMES = [
  'region-status',
  'component-status',
  'queue-depth',
  'execution-attempt-status',
  'retry-failure-counts',
  'resource-usage',
  'approvals-actions',
  'active-topology',
  'artifact-lineage',
  'execution-timeline',
] as const;

export type ProjectionName = (typeof PROJECTION_NAMES)[number];
const PROJECTOR_VERSION = 'task10.v2';

type InspectionCursor = { v: 1; afterId: string };

export function encodeInspectionCursor(id: string): string {
  return Buffer.from(
    JSON.stringify({ v: 1, afterId: id } satisfies InspectionCursor),
    'utf8',
  ).toString('base64url');
}

function decodeInspectionCursor(cursor?: string): string | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<InspectionCursor>;
    if (parsed.v !== 1 || typeof parsed.afterId !== 'string')
      throw new Error('malformed cursor');
    return parsed.afterId;
  } catch {
    throw new Error('invalid_cursor');
  }
}

function normalizeLimit(value?: number): number {
  const parsed = value ?? 50;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100)
    throw new Error('invalid_limit');
  return parsed;
}

function numericCounts(rows: readonly { key: string; count: string }[]) {
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));
}

export class ObservabilityService {
  constructor(private readonly db: Kysely<Database>) {}

  async projectionStatus() {
    const rows = await this.db
      .selectFrom('projection_checkpoints')
      .selectAll()
      .where('stream_key', '=', 'global')
      .orderBy('projection_name')
      .execute();
    const byName = new Map(rows.map((row) => [row.projection_name, row]));
    const now = Date.now();

    return Promise.all(
      PROJECTION_NAMES.map(async (projectionName) => {
        const row = byName.get(projectionName);
        return {
          projectionName,
          streamKey: 'global',
          checkpointId: row?.id ?? null,
          lastEventId: row?.last_event_id ?? null,
          lastSequenceNumber: row?.last_sequence_number ?? '0',
          updatedAt: row?.updated_at ?? null,
          stalenessMs: row
            ? Math.max(0, now - new Date(row.updated_at).getTime())
            : null,
          projectorVersion: PROJECTOR_VERSION,
          snapshot: await this.projectionSnapshot(projectionName),
        };
      }),
    );
  }

  async rebuildProjections(batchSize = 500) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000)
      throw new Error('invalid_batch_size');

    let afterId: string | undefined;
    let lastEventId: string | null = null;
    let processedEvents = 0;
    let batches = 0;

    for (;;) {
      let query = this.db
        .selectFrom('events')
        .select('id')
        .orderBy('id')
        .limit(batchSize);
      if (afterId) query = query.where('id', '>', afterId);
      const rows = await query.execute();
      if (rows.length === 0) break;
      batches += 1;
      processedEvents += rows.length;
      lastEventId = rows.at(-1)!.id;
      afterId = lastEventId;
      if (rows.length < batchSize) break;
    }

    const rebuiltAt = new Date();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('projection_checkpoints')
        .where('projection_name', 'in', [...PROJECTION_NAMES])
        .where('stream_key', '=', 'global')
        .execute();
      for (const projectionName of PROJECTION_NAMES)
        await trx
          .insertInto('projection_checkpoints')
          .values({
            id: createUuidV7(),
            projection_name: projectionName,
            stream_key: 'global',
            last_event_id: lastEventId,
            last_sequence_number: String(processedEvents),
            updated_at: rebuiltAt,
          })
          .execute();
    });

    return {
      status: 'completed' as const,
      projectorVersion: PROJECTOR_VERSION,
      processedEvents,
      processedThroughEventId: lastEventId,
      checkpointed: PROJECTION_NAMES.length,
      batches,
      batchSize,
    };
  }

  async listRegions(opts: { cursor?: string; limit?: number } = {}) {
    return this.page('regions', opts, [
      'id',
      'name',
      'parent_region_id',
      'lifecycle_status',
      'lifecycle_epoch',
      'active_topology_revision_id',
      'created_at',
    ]);
  }

  async listEvents(opts: { cursor?: string; limit?: number } = {}) {
    return this.page('events', opts, [
      'id',
      'region_id',
      'event_type',
      'stream_key',
      'sequence_number',
      'correlation_id',
      'source_kind',
      'source_command_id',
      'source_event_id',
      'source_execution_id',
      'source_attempt_id',
      'source_component_instance_id',
      'source_port_name',
      'created_at',
    ]);
  }

  async listDeliveries(opts: { cursor?: string; limit?: number } = {}) {
    return this.page('deliveries', opts, [
      'id',
      'region_id',
      'target_component_instance_id',
      'target_port_name',
      'source_command_id',
      'source_event_id',
      'correlation_id',
      'status',
      'available_at',
      'lease_owner',
      'lease_expires_at',
      'attempts_count',
      'created_at',
    ]);
  }

  async listExecutions(opts: { cursor?: string; limit?: number } = {}) {
    return this.page('executions', opts, [
      'id',
      'delivery_id',
      'region_id',
      'component_instance_id',
      'topology_revision_id',
      'lifecycle_epoch',
      'input_set_digest',
      'status',
      'completed_at',
      'failed_at',
      'failure',
      'created_at',
    ]);
  }

  async listAttempts(
    executionId?: string,
    opts: { cursor?: string; limit?: number } = {},
  ) {
    const limit = normalizeLimit(opts.limit);
    const afterId = decodeInspectionCursor(opts.cursor);
    let query = this.db
      .selectFrom('execution_attempts')
      .select([
        'id',
        'execution_id',
        'attempt_number',
        'status',
        'lease_owner',
        'lease_expires_at',
        'started_at',
        'completed_at',
        'failure',
        'created_at',
      ])
      .orderBy('id')
      .limit(limit + 1);
    if (executionId) query = query.where('execution_id', '=', executionId);
    if (afterId) query = query.where('id', '>', afterId);
    const rows = await query.execute();
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor:
        rows.length > limit ? encodeInspectionCursor(items.at(-1)!.id) : null,
    };
  }

  async listArtifacts(opts: { cursor?: string; limit?: number } = {}) {
    return this.page('artifacts', opts, [
      'id',
      'digest_algorithm',
      'digest',
      'size_bytes',
      'schema_id',
      'state',
      'media_type',
      'provenance',
      'tombstoned_at',
      'created_at',
    ]);
  }

  async artifactLineage(artifactId: string) {
    const artifact = await this.db
      .selectFrom('artifacts')
      .select([
        'id',
        'digest',
        'schema_id',
        'state',
        'provenance',
        'created_at',
      ])
      .where('id', '=', artifactId)
      .executeTakeFirst();
    if (!artifact) return null;
    const derivations = await this.db
      .selectFrom('artifact_derivations')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('artifact_id', '=', artifactId),
          eb('source_artifact_id', '=', artifactId),
        ]),
      )
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return { artifact, derivations };
  }

  async executionTrace(id: string) {
    const execution = await this.db
      .selectFrom('executions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!execution) return null;
    const delivery = await this.db
      .selectFrom('deliveries')
      .selectAll()
      .where('id', '=', execution.delivery_id)
      .executeTakeFirst();
    const command = delivery?.source_command_id
      ? await this.db
          .selectFrom('commands')
          .select(['id', 'command_type', 'correlation_id', 'created_at'])
          .where('id', '=', delivery.source_command_id)
          .executeTakeFirst()
      : null;
    const sourceEvent = delivery?.source_event_id
      ? await this.db
          .selectFrom('events')
          .selectAll()
          .where('id', '=', delivery.source_event_id)
          .executeTakeFirst()
      : null;
    const component = await this.db
      .selectFrom('component_instances')
      .select(['id', 'name', 'component_definition_id', 'configuration'])
      .where('id', '=', execution.component_instance_id)
      .executeTakeFirst();
    const attempts = await this.listAttempts(id, { limit: 100 });
    const inputs = await this.db
      .selectFrom('execution_inputs')
      .selectAll()
      .where('execution_id', '=', id)
      .orderBy('port_name')
      .orderBy('id')
      .execute();
    const outputs = await this.db
      .selectFrom('execution_outputs')
      .selectAll()
      .where('execution_id', '=', id)
      .orderBy('port_name')
      .orderBy('id')
      .execute();
    const events = await this.db
      .selectFrom('events')
      .selectAll()
      .where('source_execution_id', '=', id)
      .orderBy('id')
      .execute();
    const downstreamDeliveries = events.length
      ? await this.db
          .selectFrom('deliveries')
          .selectAll()
          .where(
            'source_event_id',
            'in',
            events.map((event) => event.id),
          )
          .orderBy('id')
          .execute()
      : [];
    return {
      execution,
      causalChain: {
        command,
        delivery,
        sourceEvent,
        component,
        inputs,
        attempts: attempts.items,
        outputs,
        events,
        downstreamDeliveries,
      },
    };
  }

  private async projectionSnapshot(projectionName: ProjectionName) {
    switch (projectionName) {
      case 'region-status': {
        const rows = await sql<{ key: string; count: string }>`
          select lifecycle_status as key, count(*)::text as count
          from regions group by lifecycle_status order by lifecycle_status
        `.execute(this.db);
        return { counts: numericCounts(rows.rows) };
      }
      case 'component-status': {
        const rows = await sql<{ key: string; count: string }>`
          select lifecycle_status as key, count(*)::text as count
          from component_instances group by lifecycle_status order by lifecycle_status
        `.execute(this.db);
        return { counts: numericCounts(rows.rows) };
      }
      case 'queue-depth': {
        const rows = await sql<{ key: string; count: string }>`
          select status as key, count(*)::text as count
          from deliveries group by status order by status
        `.execute(this.db);
        return { counts: numericCounts(rows.rows) };
      }
      case 'execution-attempt-status': {
        const executions = await sql<{ key: string; count: string }>`
          select status as key, count(*)::text as count
          from executions group by status order by status
        `.execute(this.db);
        const attempts = await sql<{ key: string; count: string }>`
          select status as key, count(*)::text as count
          from execution_attempts group by status order by status
        `.execute(this.db);
        return {
          executions: numericCounts(executions.rows),
          attempts: numericCounts(attempts.rows),
        };
      }
      case 'retry-failure-counts': {
        const row = await sql<{
          failed_attempts: string;
          replacement_attempts: string;
          dead_lettered_deliveries: string;
        }>`
          select
            (select count(*) from execution_attempts where status = 'failed')::text as failed_attempts,
            (select count(*) from execution_attempts where attempt_number > 1)::text as replacement_attempts,
            (select count(*) from deliveries where status = 'dead_lettered')::text as dead_lettered_deliveries
        `.execute(this.db);
        const value = row.rows[0];
        return {
          failedAttempts: Number(value.failed_attempts),
          replacementAttempts: Number(value.replacement_attempts),
          deadLetteredDeliveries: Number(value.dead_lettered_deliveries),
        };
      }
      case 'resource-usage': {
        const rows = await sql<{
          resource_type: string;
          unit: string;
          quantity: string;
        }>`
          select resource_type, unit, coalesce(sum(quantity::numeric), 0)::text as quantity
          from resource_ledger group by resource_type, unit order by resource_type, unit
        `.execute(this.db);
        return { totals: rows.rows };
      }
      case 'approvals-actions': {
        const approvals = await sql<{ key: string; count: string }>`
          select status as key, count(*)::text as count
          from approvals group by status order by status
        `.execute(this.db);
        const actions = await sql<{ key: string; count: string }>`
          select status as key, count(*)::text as count
          from external_actions group by status order by status
        `.execute(this.db);
        return {
          approvals: numericCounts(approvals.rows),
          externalActions: numericCounts(actions.rows),
        };
      }
      case 'active-topology': {
        const rows = await sql<{
          region_id: string;
          region_name: string;
          topology_revision_id: string | null;
          revision_number: number | null;
          components: string;
          connections: string;
        }>`
          select
            r.id as region_id,
            r.name as region_name,
            r.active_topology_revision_id as topology_revision_id,
            tr.revision_number,
            count(distinct ci.id)::text as components,
            count(distinct c.id)::text as connections
          from regions r
          left join topology_revisions tr on tr.id = r.active_topology_revision_id
          left join component_instances ci on ci.topology_revision_id = tr.id
          left join connections c on c.topology_revision_id = tr.id
          group by r.id, r.name, r.active_topology_revision_id, tr.revision_number
          order by r.id
        `.execute(this.db);
        return {
          regions: rows.rows.map((row) => ({
            ...row,
            components: Number(row.components),
            connections: Number(row.connections),
          })),
        };
      }
      case 'artifact-lineage': {
        const row = await sql<{ artifacts: string; derivations: string }>`
          select
            (select count(*) from artifacts)::text as artifacts,
            (select count(*) from artifact_derivations)::text as derivations
        `.execute(this.db);
        return {
          artifacts: Number(row.rows[0].artifacts),
          derivations: Number(row.rows[0].derivations),
        };
      }
      case 'execution-timeline': {
        const row = await sql<{
          executions: string;
          first_created_at: Date | null;
          last_created_at: Date | null;
        }>`
          select count(*)::text as executions,
                 min(created_at) as first_created_at,
                 max(created_at) as last_created_at
          from executions
        `.execute(this.db);
        return {
          executions: Number(row.rows[0].executions),
          firstCreatedAt: row.rows[0].first_created_at,
          lastCreatedAt: row.rows[0].last_created_at,
        };
      }
    }
  }

  private async page<T extends keyof Database>(
    table: T,
    opts: { cursor?: string; limit?: number },
    columns: readonly string[],
  ): Promise<Page<Record<string, unknown>>> {
    const limit = normalizeLimit(opts.limit);
    const afterId = decodeInspectionCursor(opts.cursor);
    // Dynamic table/column selection is constrained to private callers above.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = this.db
      .selectFrom(table as never)
      .select(columns as never)
      .orderBy('id')
      .limit(limit + 1);
    if (afterId) query = query.where('id', '>', afterId);
    const rows = (await query.execute()) as Record<string, unknown>[];
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor:
        rows.length > limit
          ? encodeInspectionCursor(String(items.at(-1)!.id))
          : null,
    };
  }
}
