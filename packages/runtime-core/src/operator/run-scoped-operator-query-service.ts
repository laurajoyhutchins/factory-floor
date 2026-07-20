import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import type { Database, Json } from '@factory-floor/db';
import type { Kysely } from 'kysely';
import {
  OperatorAuthorizationError,
  OperatorNotFoundError,
  OperatorValidationError,
} from './errors.js';
import { OperatorQueryService as BaseOperatorQueryService } from './operator-query-service.js';
import type {
  OperatorContext,
  PageRequest,
  RunTopologyRequest,
} from './types.js';

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;
const DEFAULT_REGION_LIMIT = 25;
const DEFAULT_COMPONENT_LIMIT = 250;
const DEFAULT_CONNECTION_LIMIT = 500;
const DEFAULT_RECORD_LIMIT = 500;
const MAX_REGION_LIMIT = 100;
const MAX_COMPONENT_LIMIT = 1_000;
const MAX_CONNECTION_LIMIT = 2_000;
const MAX_RECORD_LIMIT = 2_000;
const PROJECTION_STALE_AFTER_MS = 60_000;
const OPERATOR_CANCELLATION_CODE = 'operator_cancelled';

type RunIdentity = {
  id: string;
  region_id: string;
  region_name: string;
  command_type: string;
  correlation_id: string;
  status: string;
  created_at: unknown;
};

type CursorKind = 'run-events' | 'run-alerts';
type RunCursor = {
  v: 1;
  kind: CursorKind;
  runId: string;
  after: string;
};

type AlertSeverity = 'error' | 'warning' | 'info';
type RunAlert = {
  id: string;
  kind:
    | 'approval_required'
    | 'blocked_work'
    | 'repeated_failure'
    | 'budget_pressure'
    | 'dead_letter'
    | 'projection_stale'
    | 'execution_failed';
  severity: AlertSeverity;
  title: string;
  message: string;
  observedAt: unknown;
  source: { kind: string; id: string };
  details: Record<string, Json>;
};

export class RunScopedOperatorQueryService extends BaseOperatorQueryService {
  constructor(
    private readonly runDb: Kysely<Database>,
    blobs?: ArtifactBlobStore,
  ) {
    super(runDb, blobs);
  }

  async getRunTopology(
    context: OperatorContext,
    runId: string,
    options: RunTopologyRequest = {},
  ) {
    requireOperator(context);
    const run = await this.loadRun(runId);
    const bounds = topologyBounds(options);

    const deliveries = await this.runDb
      .selectFrom('deliveries')
      .select([
        'id',
        'region_id',
        'topology_revision_id',
        'target_component_instance_id',
        'target_port_name',
        'source_command_id',
        'source_event_id',
        'status',
        'available_at',
        'attempts_count',
        'created_at',
      ])
      .where('correlation_id', '=', run.correlation_id)
      .orderBy('id')
      .limit(bounds.recordLimit + 1)
      .execute();
    assertWithinBound(
      deliveries,
      bounds.recordLimit,
      'topology_record_bound_exceeded',
    );

    const executions = await this.runDb
      .selectFrom('executions as execution')
      .innerJoin('deliveries as delivery', 'delivery.id', 'execution.delivery_id')
      .select([
        'execution.id',
        'execution.delivery_id',
        'execution.region_id',
        'execution.component_instance_id',
        'execution.topology_revision_id',
        'execution.lifecycle_epoch',
        'execution.status',
        'execution.completed_at',
        'execution.failed_at',
        'execution.failure',
        'execution.created_at',
      ])
      .where('delivery.correlation_id', '=', run.correlation_id)
      .orderBy('execution.id')
      .limit(bounds.recordLimit + 1)
      .execute();
    assertWithinBound(
      executions,
      bounds.recordLimit,
      'topology_record_bound_exceeded',
    );

    const topologyRevisionIds = unique([
      ...deliveries.map((delivery) => delivery.topology_revision_id),
      ...executions.map((execution) => execution.topology_revision_id),
    ]);
    const topologyRevisions = topologyRevisionIds.length
      ? await this.runDb
          .selectFrom('topology_revisions')
          .select([
            'id',
            'region_id',
            'revision_number',
            'content_digest',
            'activated_at',
            'created_at',
          ])
          .where('id', 'in', topologyRevisionIds)
          .orderBy('region_id')
          .orderBy('revision_number')
          .orderBy('id')
          .execute()
      : [];

    const regionIds = unique([
      run.region_id,
      ...deliveries.map((delivery) => delivery.region_id),
      ...executions.map((execution) => execution.region_id),
      ...topologyRevisions.map((revision) => revision.region_id),
    ]);
    const regions = await this.runDb
      .selectFrom('regions')
      .select([
        'id',
        'parent_region_id',
        'name',
        'lifecycle_status',
        'lifecycle_epoch',
        'active_topology_revision_id',
        'created_at',
      ])
      .where('id', 'in', regionIds)
      .orderBy('id')
      .limit(bounds.regionLimit + 1)
      .execute();
    assertWithinBound(
      regions,
      bounds.regionLimit,
      'topology_region_bound_exceeded',
    );

    const components = topologyRevisionIds.length
      ? await this.runDb
          .selectFrom('component_instances as component')
          .innerJoin(
            'component_definitions as definition',
            'definition.id',
            'component.component_definition_id',
          )
          .select([
            'component.id',
            'component.region_id',
            'component.topology_revision_id',
            'component.name',
            'component.lifecycle_status',
            'component.component_definition_id',
            'definition.name as component_definition_name',
            'definition.version as component_definition_version',
            'definition.content_digest as component_definition_digest',
          ])
          .where('component.topology_revision_id', 'in', topologyRevisionIds)
          .orderBy('component.region_id')
          .orderBy('component.name')
          .orderBy('component.id')
          .limit(bounds.componentLimit + 1)
          .execute()
      : [];
    assertWithinBound(
      components,
      bounds.componentLimit,
      'topology_component_bound_exceeded',
    );

    const definitionIds = unique(
      components.map((component) => component.component_definition_id),
    );
    const ports = definitionIds.length
      ? await this.runDb
          .selectFrom('port_definitions')
          .select([
            'id',
            'component_definition_id',
            'name',
            'direction',
            'schema_id',
            'required',
          ])
          .where('component_definition_id', 'in', definitionIds)
          .orderBy('component_definition_id')
          .orderBy('direction')
          .orderBy('name')
          .orderBy('id')
          .execute()
      : [];
    const portsByDefinition = groupBy(
      ports,
      (port) => port.component_definition_id,
    );

    const connections = topologyRevisionIds.length
      ? await this.runDb
          .selectFrom('connections')
          .selectAll()
          .where('topology_revision_id', 'in', topologyRevisionIds)
          .orderBy('topology_revision_id')
          .orderBy('source_component_instance_id')
          .orderBy('source_port_name')
          .orderBy('target_component_instance_id')
          .orderBy('target_port_name')
          .orderBy('id')
          .limit(bounds.connectionLimit + 1)
          .execute()
      : [];
    assertWithinBound(
      connections,
      bounds.connectionLimit,
      'topology_connection_bound_exceeded',
    );

    return {
      run: {
        id: run.id,
        commandType: run.command_type,
        regionId: run.region_id,
        regionName: run.region_name,
        status: run.status,
        createdAt: run.created_at,
      },
      bounds,
      regions,
      topologyRevisions,
      components: components.map((component) => ({
        id: component.id,
        regionId: component.region_id,
        topologyRevisionId: component.topology_revision_id,
        name: component.name,
        lifecycleStatus: component.lifecycle_status,
        definition: {
          id: component.component_definition_id,
          name: component.component_definition_name,
          version: component.component_definition_version,
          digest: component.component_definition_digest,
        },
        ports: portsByDefinition.get(component.component_definition_id) ?? [],
      })),
      connections,
      deliveries,
      executions,
      relationships: topologyRelationships(connections, deliveries, executions),
    };
  }

  async listRunEvents(
    context: OperatorContext,
    runId: string,
    page: PageRequest = {},
  ) {
    requireOperator(context);
    const run = await this.loadRun(runId);
    const limit = normalizePageLimit(page.limit);
    const cursor = decodeRunCursor(page.cursor, 'run-events', run.id);
    if (cursor)
      await this.assertEventCursorAnchor(run.correlation_id, cursor.after);

    let query = this.runDb
      .selectFrom('events')
      .select([
        'id',
        'region_id',
        'event_type',
        'payload',
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
      ])
      .where('correlation_id', '=', run.correlation_id)
      .orderBy('id')
      .limit(limit + 1);
    if (cursor) query = query.where('id', '>', cursor.after);
    const rows = await query.execute();
    const items = rows.slice(0, limit);
    const lastId = items.at(-1)?.id ?? cursor?.after ?? null;
    return {
      items,
      nextCursor:
        rows.length > limit && lastId
          ? encodeRunCursor('run-events', run.id, lastId)
          : null,
      resumeCursor: lastId
        ? encodeRunCursor('run-events', run.id, lastId)
        : null,
      complete: rows.length <= limit,
    };
  }

  async listRunAlerts(
    context: OperatorContext,
    runId: string,
    page: PageRequest = {},
  ) {
    requireOperator(context);
    const run = await this.loadRun(runId);
    const limit = normalizePageLimit(page.limit);
    const alerts = await this.projectRunAlerts(run);
    const cursor = decodeRunCursor(page.cursor, 'run-alerts', run.id);
    let start = 0;
    if (cursor) {
      const index = alerts.findIndex(
        (alert) => alertSortKey(alert) === cursor.after,
      );
      if (index < 0) throw new OperatorValidationError('cursor_expired');
      start = index + 1;
    }
    const items = alerts.slice(start, start + limit);
    const hasMore = start + items.length < alerts.length;
    return {
      items,
      nextCursor:
        hasMore && items.length
          ? encodeRunCursor(
              'run-alerts',
              run.id,
              alertSortKey(items.at(-1)!),
            )
          : null,
      complete: !hasMore,
      generatedAt: new Date().toISOString(),
    };
  }

  async readRunArtifact(
    context: OperatorContext,
    runId: string,
    artifactId: string,
    maxBytes?: number,
  ) {
    requireOperator(context);
    const run = await this.loadRun(runId);
    const owned = await this.runDb
      .selectFrom('execution_outputs as output')
      .innerJoin('executions as execution', 'execution.id', 'output.execution_id')
      .innerJoin('deliveries as delivery', 'delivery.id', 'execution.delivery_id')
      .select('output.artifact_id')
      .where('output.artifact_id', '=', artifactId)
      .where('delivery.correlation_id', '=', run.correlation_id)
      .executeTakeFirst();
    if (!owned) throw new OperatorNotFoundError('artifact_not_found');
    return this.readArtifact(context, artifactId, maxBytes);
  }

  private async loadRun(runId: string): Promise<RunIdentity> {
    const run = await this.runDb
      .selectFrom('commands as command')
      .innerJoin('regions as region', 'region.id', 'command.region_id')
      .select([
        'command.id',
        'command.region_id',
        'region.name as region_name',
        'command.command_type',
        'command.correlation_id',
        'command.status',
        'command.created_at',
      ])
      .where('command.id', '=', runId)
      .executeTakeFirst();
    if (!run) throw new OperatorNotFoundError('run_not_found');
    if (!run.correlation_id)
      throw new OperatorValidationError('run_missing_correlation_id');
    return { ...run, correlation_id: run.correlation_id };
  }

  private async assertEventCursorAnchor(
    correlationId: string,
    eventId: string,
  ): Promise<void> {
    const anchor = await this.runDb
      .selectFrom('events')
      .select('id')
      .where('id', '=', eventId)
      .where('correlation_id', '=', correlationId)
      .executeTakeFirst();
    if (!anchor) throw new OperatorValidationError('cursor_expired');
  }

  private async projectRunAlerts(run: RunIdentity): Promise<RunAlert[]> {
    const [deliveries, executions, approvals, checkpoints, resourceRows] =
      await Promise.all([
        this.runDb
          .selectFrom('deliveries')
          .select([
            'id',
            'region_id',
            'status',
            'attempts_count',
            'created_at',
          ])
          .where('correlation_id', '=', run.correlation_id)
          .orderBy('id')
          .execute(),
        this.runDb
          .selectFrom('executions as execution')
          .innerJoin(
            'deliveries as delivery',
            'delivery.id',
            'execution.delivery_id',
          )
          .select([
            'execution.id',
            'execution.status',
            'execution.failure',
            'execution.failed_at',
            'execution.created_at',
          ])
          .where('delivery.correlation_id', '=', run.correlation_id)
          .orderBy('execution.id')
          .execute(),
        this.runDb
          .selectFrom('approvals as approval')
          .innerJoin(
            'external_actions as action',
            'action.approval_id',
            'approval.id',
          )
          .innerJoin(
            'executions as execution',
            'execution.id',
            'action.execution_id',
          )
          .innerJoin(
            'deliveries as delivery',
            'delivery.id',
            'execution.delivery_id',
          )
          .select([
            'approval.id',
            'approval.requested_at',
            'action.action_type',
            'action.risk',
          ])
          .where('approval.status', '=', 'requested')
          .where('delivery.correlation_id', '=', run.correlation_id)
          .orderBy('approval.id')
          .execute(),
        this.runDb
          .selectFrom('projection_checkpoints')
          .select(['id', 'projection_name', 'updated_at'])
          .where('stream_key', '=', 'global')
          .orderBy('projection_name')
          .execute(),
        this.runDb
          .selectFrom('resource_ledger as resource')
          .innerJoin(
            'executions as execution',
            'execution.id',
            'resource.execution_id',
          )
          .innerJoin(
            'deliveries as delivery',
            'delivery.id',
            'execution.delivery_id',
          )
          .select([
            'resource.id',
            'resource.resource_type',
            'resource.quantity',
            'resource.unit',
            'resource.attributes',
            'resource.created_at',
          ])
          .where('delivery.correlation_id', '=', run.correlation_id)
          .orderBy('resource.id')
          .execute(),
      ]);

    const blockedRegions = await this.runDb
      .selectFrom('regions')
      .select(['id', 'name', 'created_at'])
      .where(
        'id',
        'in',
        unique([run.region_id, ...deliveries.map((row) => row.region_id)]),
      )
      .where('lifecycle_status', '=', 'blocked')
      .orderBy('id')
      .execute();
    const attempts = executions.length
      ? await this.runDb
          .selectFrom('execution_attempts')
          .select([
            'id',
            'execution_id',
            'completed_at',
            'created_at',
          ])
          .where(
            'execution_id',
            'in',
            executions.map((execution) => execution.id),
          )
          .where('status', 'in', ['failed', 'abandoned'])
          .orderBy('execution_id')
          .orderBy('id')
          .execute()
      : [];
    const attemptsByExecution = groupBy(
      attempts,
      (attempt) => attempt.execution_id,
    );

    const alerts: RunAlert[] = [];
    for (const approval of approvals)
      alerts.push({
        id: `approval-required:${approval.id}`,
        kind: 'approval_required',
        severity: 'warning',
        title: 'Approval required',
        message: `${approval.action_type} is awaiting an operator decision.`,
        observedAt: approval.requested_at,
        source: { kind: 'approval', id: approval.id },
        details: { actionType: approval.action_type, risk: approval.risk },
      });
    for (const region of blockedRegions)
      alerts.push({
        id: `blocked-work:${region.id}`,
        kind: 'blocked_work',
        severity: 'error',
        title: 'Run work is blocked',
        message: `Region ${region.name} is blocked.`,
        observedAt: region.created_at,
        source: { kind: 'region', id: region.id },
        details: { regionName: region.name },
      });
    for (const delivery of deliveries.filter(
      (row) => row.status === 'dead_lettered',
    ))
      alerts.push({
        id: `dead-letter:${delivery.id}`,
        kind: 'dead_letter',
        severity: 'error',
        title: 'Delivery dead-lettered',
        message: 'A run delivery exhausted its retry path.',
        observedAt: delivery.created_at,
        source: { kind: 'delivery', id: delivery.id },
        details: { attemptsCount: delivery.attempts_count },
      });
    for (const execution of executions) {
      if (
        execution.status === 'failed' &&
        !isOperatorCancellation(execution.failure)
      )
        alerts.push({
          id: `execution-failed:${execution.id}`,
          kind: 'execution_failed',
          severity: 'error',
          title: 'Execution failed',
          message: failureMessage(execution.failure, 'Execution failed.'),
          observedAt: execution.failed_at ?? execution.created_at,
          source: { kind: 'execution', id: execution.id },
          details: { failure: execution.failure },
        });
      const failedAttempts = attemptsByExecution.get(execution.id) ?? [];
      if (failedAttempts.length >= 2)
        alerts.push({
          id: `repeated-failure:${execution.id}`,
          kind: 'repeated_failure',
          severity: 'warning',
          title: 'Repeated execution failure',
          message: `Execution has ${failedAttempts.length} failed or abandoned attempts.`,
          observedAt:
            failedAttempts.at(-1)?.completed_at ??
            failedAttempts.at(-1)?.created_at ??
            execution.created_at,
          source: { kind: 'execution', id: execution.id },
          details: { attemptCount: failedAttempts.length },
        });
    }
    for (const resource of resourceRows) {
      const limit = budgetLimit(resource.attributes);
      if (limit === null || !isBudgetPressure(resource.quantity, limit)) continue;
      alerts.push({
        id: `budget-pressure:${resource.id}`,
        kind: 'budget_pressure',
        severity: 'warning',
        title: 'Resource budget pressure',
        message: `${resource.resource_type} usage is at least 80% of its durable limit.`,
        observedAt: resource.created_at,
        source: { kind: 'resource_ledger', id: resource.id },
        details: {
          resourceType: resource.resource_type,
          quantity: resource.quantity,
          unit: resource.unit,
          budgetLimit: limit,
        },
      });
    }
    for (const checkpoint of checkpoints) {
      const updatedAt = new Date(String(checkpoint.updated_at));
      const stalenessMs = Math.max(0, Date.now() - updatedAt.getTime());
      if (!Number.isFinite(stalenessMs) || stalenessMs <= PROJECTION_STALE_AFTER_MS)
        continue;
      alerts.push({
        id: `projection-stale:${checkpoint.projection_name}`,
        kind: 'projection_stale',
        severity: 'warning',
        title: 'Projection is stale',
        message: `${checkpoint.projection_name} has not advanced within the operator freshness window.`,
        observedAt: checkpoint.updated_at,
        source: { kind: 'projection_checkpoint', id: checkpoint.id },
        details: {
          projectionName: checkpoint.projection_name,
          stalenessMs,
        },
      });
    }

    return alerts.sort((left, right) =>
      alertSortKey(left).localeCompare(alertSortKey(right)),
    );
  }
}

function topologyBounds(options: RunTopologyRequest) {
  return {
    regionLimit: normalizeBound(
      options.regionLimit,
      DEFAULT_REGION_LIMIT,
      MAX_REGION_LIMIT,
      'invalid_region_limit',
    ),
    componentLimit: normalizeBound(
      options.componentLimit,
      DEFAULT_COMPONENT_LIMIT,
      MAX_COMPONENT_LIMIT,
      'invalid_component_limit',
    ),
    connectionLimit: normalizeBound(
      options.connectionLimit,
      DEFAULT_CONNECTION_LIMIT,
      MAX_CONNECTION_LIMIT,
      'invalid_connection_limit',
    ),
    recordLimit: normalizeBound(
      options.recordLimit,
      DEFAULT_RECORD_LIMIT,
      MAX_RECORD_LIMIT,
      'invalid_record_limit',
    ),
  };
}

function topologyRelationships(
  connections: readonly {
    id: string;
    source_component_instance_id: string;
    source_port_name: string;
    target_component_instance_id: string;
    target_port_name: string;
  }[],
  deliveries: readonly {
    id: string;
    target_component_instance_id: string;
    target_port_name: string;
  }[],
  executions: readonly {
    id: string;
    delivery_id: string;
    component_instance_id: string;
  }[],
) {
  return [
    ...connections.map((connection) => ({
      id: `connection:${connection.id}`,
      kind: 'connection' as const,
      source: {
        kind: 'component' as const,
        id: connection.source_component_instance_id,
        port: connection.source_port_name,
      },
      target: {
        kind: 'component' as const,
        id: connection.target_component_instance_id,
        port: connection.target_port_name,
      },
    })),
    ...deliveries.map((delivery) => ({
      id: `delivery-target:${delivery.id}`,
      kind: 'delivery_target' as const,
      source: { kind: 'delivery' as const, id: delivery.id },
      target: {
        kind: 'component' as const,
        id: delivery.target_component_instance_id,
        port: delivery.target_port_name,
      },
    })),
    ...executions.flatMap((execution) => [
      {
        id: `execution-delivery:${execution.id}`,
        kind: 'execution_delivery' as const,
        source: { kind: 'delivery' as const, id: execution.delivery_id },
        target: { kind: 'execution' as const, id: execution.id },
      },
      {
        id: `execution-component:${execution.id}`,
        kind: 'execution_component' as const,
        source: { kind: 'execution' as const, id: execution.id },
        target: {
          kind: 'component' as const,
          id: execution.component_instance_id,
        },
      },
    ]),
  ];
}

function requireOperator(context: OperatorContext): void {
  if (
    !context.principal.roles.includes('operator') &&
    !context.principal.roles.includes('admin')
  )
    throw new OperatorAuthorizationError();
}

function normalizeBound(
  value: number | undefined,
  fallback: number,
  maximum: number,
  code: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > maximum)
    throw new OperatorValidationError(code);
  return normalized;
}

function normalizePageLimit(value?: number): number {
  return normalizeBound(
    value,
    DEFAULT_PAGE_LIMIT,
    MAX_PAGE_LIMIT,
    'invalid_limit',
  );
}

function assertWithinBound<T>(
  rows: readonly T[],
  limit: number,
  code: string,
): void {
  if (rows.length > limit) throw new OperatorValidationError(code);
}

function encodeRunCursor(
  kind: CursorKind,
  runId: string,
  after: string,
): string {
  return Buffer.from(
    JSON.stringify({ v: 1, kind, runId, after } satisfies RunCursor),
    'utf8',
  ).toString('base64url');
}

function decodeRunCursor(
  value: string | undefined,
  expectedKind: CursorKind,
  runId: string,
): RunCursor | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<RunCursor>;
    if (
      decoded.v !== 1 ||
      decoded.kind !== expectedKind ||
      typeof decoded.runId !== 'string' ||
      typeof decoded.after !== 'string' ||
      decoded.after.length === 0
    )
      throw new Error('malformed');
    if (decoded.runId !== runId)
      throw new OperatorValidationError('cursor_run_mismatch');
    return decoded as RunCursor;
  } catch (error) {
    if (error instanceof OperatorValidationError) throw error;
    throw new OperatorValidationError('invalid_cursor');
  }
}

function alertSortKey(alert: RunAlert): string {
  const rank: Record<AlertSeverity, string> = {
    error: '0',
    warning: '1',
    info: '2',
  };
  return `${rank[alert.severity]}:${alert.kind}:${alert.id}`;
}

function isRecord(value: Json): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function budgetLimit(attributes: Json): string | null {
  if (!isRecord(attributes)) return null;
  const value = attributes.budgetLimit ?? attributes.budget_limit;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value;
  return null;
}

function isBudgetPressure(quantity: string, limit: string): boolean {
  try {
    return BigInt(quantity) * 100n >= BigInt(limit) * 80n;
  } catch {
    return false;
  }
}

function isOperatorCancellation(value: Json | null): boolean {
  return (
    value !== null &&
    isRecord(value) &&
    value.code === OPERATOR_CANCELLATION_CODE
  );
}

function failureMessage(value: Json | null, fallback: string): string {
  if (!value || !isRecord(value)) return fallback;
  const message = value.message;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values)
    grouped.set(key(value), [...(grouped.get(key(value)) ?? []), value]);
  return grouped;
}

export const runScopedCursorSemantics = {
  version: 1 as const,
  eventKind: 'run-events' as const,
  alertKind: 'run-alerts' as const,
  projectionStaleAfterMs: PROJECTION_STALE_AFTER_MS,
};
