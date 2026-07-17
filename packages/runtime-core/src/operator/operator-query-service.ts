import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import type { Database, Json } from '@factory-floor/db';
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  OperatorAuthorizationError,
  OperatorNotFoundError,
  OperatorValidationError,
} from './errors.js';
import type { OperatorContext, PageRequest } from './types.js';

const TEXT_MEDIA =
  /^(application\/(json|yaml|x-yaml)|text\/(plain|markdown|x-diff|yaml)|application\/vnd\.factory-floor\.|text\/x-)/;
const TRACE_LIMIT = 100;
const OPERATOR_CANCELLATION_CODE = 'operator_cancelled';

type CommandRow = Selectable<Database['commands']>;
type RunRow = {
  id: string;
  region_id: string;
  region_name: string;
  command_type: string;
  correlation_id: string;
  status: string;
  rejection: CommandRow['rejection'];
  created_at: CommandRow['created_at'];
};

export class OperatorQueryService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly blobs?: ArtifactBlobStore,
  ) {}

  async getFactoryStatus(context: OperatorContext) {
    requireOperator(context);
    const [deliveries, executions, approvals, failures] = await Promise.all([
      this.db
        .selectFrom('deliveries')
        .select(sql<string>`count(*)`.as('count'))
        .where('status', '=', 'ready')
        .executeTakeFirst(),
      this.db
        .selectFrom('executions')
        .select(sql<string>`count(*)`.as('count'))
        .where('status', '=', 'running')
        .executeTakeFirst(),
      this.db
        .selectFrom('approvals')
        .select(sql<string>`count(*)`.as('count'))
        .where('status', '=', 'requested')
        .executeTakeFirst(),
      sql<{ count: string }>`
        select count(*)::text as count
        from executions
        where status = 'failed'
          and coalesce(failure->>'code', '') <> ${OPERATOR_CANCELLATION_CODE}
          and created_at >= now() - interval '1 day'
      `
        .execute(this.db)
        .then((result) => result.rows[0]),
    ]);
    return {
      status: 'healthy' as const,
      generatedAt: new Date().toISOString(),
      readyDeliveries: Number(deliveries?.count ?? 0),
      activeExecutions: Number(executions?.count ?? 0),
      pendingApprovals: Number(approvals?.count ?? 0),
      recentFailures: Number(failures?.count ?? 0),
    };
  }

  async getRunStatus(context: OperatorContext, runId: string) {
    requireOperator(context);
    const run = await this.findRun(runId);
    const graph = await this.runGraph(run);
    const deliveryCounts = countStatuses(graph.deliveries);
    const executionCounts = countStatuses(graph.executions);
    const cancelledExecutions = graph.executions.filter((execution) =>
      isOperatorCancellation(execution.failure),
    ).length;
    const failedExecutions = graph.executions.filter(
      (execution) =>
        execution.status === 'failed' &&
        !isOperatorCancellation(execution.failure),
    ).length;
    const retryCount = graph.attempts.filter(
      (attempt) => attempt.attempt_number > 1,
    ).length;
    const executionIds = graph.executions.map((execution) => execution.id);
    const pendingApprovalCount = executionIds.length
      ? Number(
          (
            await this.db
              .selectFrom('approvals as approval')
              .innerJoin(
                'external_actions as action',
                'action.approval_id',
                'approval.id',
              )
              .select(sql<string>`count(distinct approval.id)`.as('count'))
              .where('approval.status', '=', 'requested')
              .where('action.execution_id', 'in', executionIds)
              .executeTakeFirst()
          )?.count ?? 0,
        )
      : 0;
    const status = runStatus(
      run.status,
      deliveryCounts,
      executionCounts,
      cancelledExecutions,
      failedExecutions,
    );
    const terminalAt = graph.executions
      .map((execution) => execution.completed_at ?? execution.failed_at)
      .filter((value): value is Date => value !== null)
      .sort((left, right) => right.getTime() - left.getTime())[0];
    const nonCancellationFailure = graph.executions.find(
      (execution) =>
        execution.status === 'failed' &&
        !isOperatorCancellation(execution.failure),
    )?.failure;
    const cancellationFailure = graph.executions.find((execution) =>
      isOperatorCancellation(execution.failure),
    )?.failure;
    return {
      runId: run.id,
      commandType: run.command_type,
      regionId: run.region_id,
      regionName: run.region_name,
      status,
      counts: {
        queued: deliveryCounts.ready ?? 0,
        active: executionCounts.running ?? 0,
        completed: executionCounts.completed ?? 0,
        failed: failedExecutions,
        cancelled: Math.max(cancelledExecutions, deliveryCounts.cancelled ?? 0),
      },
      retryCount,
      pendingApprovalCount,
      blockingReason:
        nonCancellationFailure ?? cancellationFailure ?? run.rejection ?? null,
      createdAt: run.created_at,
      completedAt: terminalAt ?? null,
      terminalResultSummary: [
        'completed',
        'failed',
        'cancelled',
        'rejected',
      ].includes(status)
        ? status
        : null,
    };
  }

  async inspectRunTrace(context: OperatorContext, runId: string) {
    requireOperator(context);
    const run = await this.findRun(runId);
    const graph = await this.runGraph(run, TRACE_LIMIT + 1);
    const bounded = <T>(items: T[]) => ({
      items: items.slice(0, TRACE_LIMIT),
      truncated: items.length > TRACE_LIMIT,
    });
    const executionIds = graph.executions.map((execution) => execution.id);
    const outputs = executionIds.length
      ? await this.db
          .selectFrom('execution_outputs')
          .selectAll()
          .where('execution_id', 'in', executionIds)
          .orderBy('id')
          .limit(TRACE_LIMIT + 1)
          .execute()
      : [];
    const events = await this.db
      .selectFrom('events')
      .selectAll()
      .where('region_id', '=', run.region_id)
      .where('correlation_id', '=', run.correlation_id)
      .orderBy('id')
      .limit(TRACE_LIMIT + 1)
      .execute();
    return {
      run,
      deliveries: bounded(graph.deliveries),
      executions: bounded(graph.executions),
      attempts: bounded(graph.attempts),
      outputs: bounded(outputs),
      events: bounded(events),
    };
  }

  async listRunArtifacts(
    context: OperatorContext,
    runId: string,
    page: PageRequest = {},
  ) {
    requireOperator(context);
    const run = await this.findRun(runId);
    const limit = normalizeLimit(page.limit, 50);
    const afterId = decodeCursor(page.cursor);
    let query = this.db
      .selectFrom('artifacts as artifact')
      .innerJoin(
        'artifact_schemas as schema',
        'schema.id',
        'artifact.schema_id',
      )
      .innerJoin(
        'execution_outputs as output',
        'output.artifact_id',
        'artifact.id',
      )
      .innerJoin(
        'executions as execution',
        'execution.id',
        'output.execution_id',
      )
      .innerJoin(
        'deliveries as delivery',
        'delivery.id',
        'execution.delivery_id',
      )
      .select([
        'artifact.id',
        'artifact.digest_algorithm',
        'artifact.digest',
        'artifact.size_bytes',
        'artifact.schema_id',
        'schema.name as schema_name',
        'schema.version as schema_version',
        'schema.content_digest as schema_digest',
        'artifact.state',
        'artifact.media_type',
        'artifact.committed_locator',
        'artifact.provenance',
        'artifact.tombstoned_at',
        'artifact.created_at',
      ])
      .distinct()
      .where('delivery.region_id', '=', run.region_id)
      .where('delivery.correlation_id', '=', run.correlation_id)
      .orderBy('artifact.id')
      .limit(limit + 1);
    if (afterId) query = query.where('artifact.id', '>', afterId);
    const rows = await query.execute();
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor: rows.length > limit ? encodeCursor(items.at(-1)!.id) : null,
    };
  }

  async readArtifact(
    context: OperatorContext,
    artifactId: string,
    maxBytes = 65_536,
  ) {
    requireOperator(context);
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576)
      throw new OperatorValidationError('invalid_artifact_byte_limit');
    const artifact = await this.db
      .selectFrom('artifacts')
      .selectAll()
      .where('id', '=', artifactId)
      .executeTakeFirst();
    if (!artifact) throw new OperatorNotFoundError('artifact_not_found');
    const metadata = {
      artifactId: artifact.id,
      mediaType: artifact.media_type,
      byteSize: Number(artifact.size_bytes),
      digest: artifact.digest,
      state: artifact.state,
      provenance: artifact.provenance,
    };
    if (
      artifact.state !== 'committed' ||
      !TEXT_MEDIA.test(artifact.media_type) ||
      !this.blobs
    )
      return {
        ...metadata,
        content: null,
        truncated: false,
        readable: false,
      };

    const chunks: Buffer[] = [];
    let collected = 0;
    let observed = 0;
    for await (const chunk of await this.blobs.readCommitted(artifact.digest)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      observed += buffer.length;
      if (collected < maxBytes) {
        const accepted = buffer.subarray(0, maxBytes - collected);
        chunks.push(accepted);
        collected += accepted.length;
      }
      if (observed > maxBytes) break;
    }
    return {
      ...metadata,
      content: Buffer.concat(chunks).toString('utf8'),
      truncated: observed > maxBytes,
      readable: true,
    };
  }

  async listPendingApprovals(context: OperatorContext, page: PageRequest = {}) {
    requireOperator(context);
    const limit = normalizeLimit(page.limit, 50);
    const afterId = decodeCursor(page.cursor);
    let query = this.db
      .selectFrom('approvals as approval')
      .innerJoin(
        'policy_decisions as decision',
        'decision.id',
        'approval.policy_decision_id',
      )
      .select([
        'approval.id',
        'approval.status',
        'approval.requested_at',
        'decision.policy_name',
        'decision.policy_version',
        'decision.subject_kind',
        'decision.subject_id',
        'decision.reason',
        'decision.normalized_inputs',
      ])
      .where('approval.status', '=', 'requested')
      .orderBy('approval.id')
      .limit(limit + 1);
    if (afterId) query = query.where('approval.id', '>', afterId);
    const rows = await query.execute();
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor: rows.length > limit ? encodeCursor(items.at(-1)!.id) : null,
    };
  }

  private async findRun(runId: string): Promise<RunRow> {
    const run = await this.db
      .selectFrom('commands as command')
      .innerJoin('regions as region', 'region.id', 'command.region_id')
      .select([
        'command.id',
        'command.region_id',
        'region.name as region_name',
        'command.command_type',
        'command.correlation_id',
        'command.status',
        'command.rejection',
        'command.created_at',
      ])
      .where('command.id', '=', runId)
      .executeTakeFirst();
    if (!run) throw new OperatorNotFoundError('run_not_found');
    if (!run.correlation_id)
      throw new OperatorValidationError('run_missing_correlation_id');
    return { ...run, correlation_id: run.correlation_id };
  }

  private async runGraph(run: RunRow, limit?: number) {
    let deliveryQuery = this.db
      .selectFrom('deliveries')
      .selectAll()
      .where('region_id', '=', run.region_id)
      .where('correlation_id', '=', run.correlation_id)
      .orderBy('id');
    if (limit) deliveryQuery = deliveryQuery.limit(limit);
    const deliveries = await deliveryQuery.execute();
    const deliveryIds = deliveries.map((delivery) => delivery.id);

    let executionQuery = this.db
      .selectFrom('executions')
      .selectAll()
      .orderBy('id');
    if (deliveryIds.length)
      executionQuery = executionQuery.where('delivery_id', 'in', deliveryIds);
    if (limit) executionQuery = executionQuery.limit(limit);
    const executions = deliveryIds.length ? await executionQuery.execute() : [];
    const executionIds = executions.map((execution) => execution.id);

    let attemptQuery = this.db
      .selectFrom('execution_attempts')
      .selectAll()
      .orderBy('id');
    if (executionIds.length)
      attemptQuery = attemptQuery.where('execution_id', 'in', executionIds);
    if (limit) attemptQuery = attemptQuery.limit(limit);
    const attempts = executionIds.length ? await attemptQuery.execute() : [];
    return { deliveries, executions, attempts };
  }
}

function requireOperator(context: OperatorContext) {
  if (
    !context.principal.roles.includes('operator') &&
    !context.principal.roles.includes('admin')
  )
    throw new OperatorAuthorizationError();
}

function countStatuses(rows: readonly { status: string }[]) {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}

function runStatus(
  commandStatus: string,
  deliveryCounts: Record<string, number>,
  executionCounts: Record<string, number>,
  cancelledExecutions: number,
  failedExecutions: number,
) {
  if (commandStatus === 'rejected') return 'rejected';
  if ((executionCounts.running ?? 0) > 0) return 'running';
  if ((deliveryCounts.ready ?? 0) > 0 || (deliveryCounts.leased ?? 0) > 0)
    return 'queued';
  if (cancelledExecutions > 0 || (deliveryCounts.cancelled ?? 0) > 0)
    return 'cancelled';
  if (failedExecutions > 0) return 'failed';
  if ((executionCounts.completed ?? 0) > 0) return 'completed';
  return 'accepted';
}

function normalizeLimit(value: number | undefined, maximum: number) {
  const limit = value ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum)
    throw new OperatorValidationError('invalid_limit');
  return limit;
}

function encodeCursor(id: string) {
  return Buffer.from(JSON.stringify({ v: 1, afterId: id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor?: string) {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { v?: number; afterId?: unknown };
    if (parsed.v !== 1 || typeof parsed.afterId !== 'string')
      throw new Error('invalid');
    return parsed.afterId;
  } catch {
    throw new OperatorValidationError('invalid_cursor');
  }
}

function isOperatorCancellation(value: Json | null) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value.code === OPERATOR_CANCELLATION_CODE
  );
}
