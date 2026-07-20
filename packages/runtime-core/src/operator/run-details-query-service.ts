import type { Database, Json } from '@factory-floor/db';
import type { Kysely } from 'kysely';
import {
  OperatorAuthorizationError,
  OperatorNotFoundError,
  OperatorValidationError,
} from './errors.js';
import type { OperatorContext } from './types.js';

const DEFAULT_DETAIL_LIMIT = 100;
const MAX_DETAIL_LIMIT = 500;
const PROJECTION_STALE_AFTER_MS = 60_000;

type RunIdentity = {
  id: string;
  correlationId: string;
};

export interface RunDetailsRequest {
  limit?: number;
}

export class RunDetailsQueryService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly now = () => new Date(),
  ) {}

  async getRunDetails(
    context: OperatorContext,
    runId: string,
    request: RunDetailsRequest = {},
  ) {
    requireOperator(context);
    const run = await this.loadRun(runId);
    const limit = normalizeLimit(request.limit);

    const executions = await this.db
      .selectFrom('executions as execution')
      .innerJoin(
        'deliveries as delivery',
        'delivery.id',
        'execution.delivery_id',
      )
      .select(['execution.id'])
      .where('delivery.correlation_id', '=', run.correlationId)
      .orderBy('execution.id')
      .limit(limit + 1)
      .execute();
    assertWithinBound(executions, limit, 'run_details_execution_bound_exceeded');
    const executionIds = executions.map((execution) => execution.id);

    const attempts = executionIds.length
      ? await this.db
          .selectFrom('execution_attempts')
          .select('id')
          .where('execution_id', 'in', executionIds)
          .orderBy('id')
          .limit(limit + 1)
          .execute()
      : [];
    assertWithinBound(attempts, limit, 'run_details_attempt_bound_exceeded');
    const attemptIds = attempts.map((attempt) => attempt.id);

    const actions = executionIds.length
      ? await this.db
          .selectFrom('external_actions')
          .select([
            'id',
            'execution_id',
            'attempt_id',
            'outbound_request_artifact_id',
            'policy_decision_id',
            'approval_id',
            'action_type',
            'risk',
            'status',
            'created_at',
          ])
          .where('execution_id', 'in', executionIds)
          .orderBy('id')
          .limit(limit + 1)
          .execute()
      : [];
    assertWithinBound(actions, limit, 'run_details_action_bound_exceeded');
    const actionIds = actions.map((action) => action.id);

    const approvals = actionIds.length
      ? await this.db
          .selectFrom('approvals as approval')
          .innerJoin(
            'external_actions as action',
            'action.approval_id',
            'approval.id',
          )
          .innerJoin(
            'policy_decisions as decision',
            'decision.id',
            'approval.policy_decision_id',
          )
          .select([
            'approval.id',
            'approval.status',
            'approval.requested_at',
            'approval.decided_at',
            'approval.decided_by',
            'approval.decision_reason',
            'action.id as action_id',
            'action.action_type',
            'action.risk',
            'action.status as action_status',
            'decision.id as policy_decision_id',
            'decision.policy_name',
            'decision.policy_version',
            'decision.outcome',
            'decision.reason as policy_reason',
          ])
          .where('action.id', 'in', actionIds)
          .orderBy('approval.id')
          .limit(limit + 1)
          .execute()
      : [];
    assertWithinBound(approvals, limit, 'run_details_approval_bound_exceeded');

    const policyDecisions = actionIds.length
      ? await this.db
          .selectFrom('policy_decisions as decision')
          .innerJoin(
            'external_actions as action',
            'action.policy_decision_id',
            'decision.id',
          )
          .select([
            'decision.id',
            'decision.policy_name',
            'decision.policy_version',
            'decision.evaluator_version',
            'decision.subject_kind',
            'decision.subject_id',
            'decision.input_artifact_id',
            'decision.normalized_inputs',
            'decision.outcome',
            'decision.reason',
            'decision.modifications',
            'decision.created_at',
            'action.id as action_id',
            'action.action_type',
            'action.risk',
            'action.status as action_status',
          ])
          .where('action.id', 'in', actionIds)
          .orderBy('decision.id')
          .limit(limit + 1)
          .execute()
      : [];
    assertWithinBound(
      policyDecisions,
      limit,
      'run_details_policy_bound_exceeded',
    );

    const resources =
      executionIds.length || actionIds.length
        ? await this.db
            .selectFrom('resource_ledger as resource')
            .select([
              'resource.id',
              'resource.region_id',
              'resource.execution_id',
              'resource.attempt_id',
              'resource.external_action_id',
              'resource.resource_type',
              'resource.quantity',
              'resource.unit',
              'resource.attributes',
              'resource.created_at',
            ])
            .where(({ eb, or }) =>
              or([
                ...(executionIds.length
                  ? [eb('resource.execution_id', 'in', executionIds)]
                  : []),
                ...(actionIds.length
                  ? [eb('resource.external_action_id', 'in', actionIds)]
                  : []),
              ]),
            )
            .orderBy('resource.id')
            .limit(limit + 1)
            .execute()
        : [];
    assertWithinBound(resources, limit, 'run_details_resource_bound_exceeded');

    const artifactIds = unique([
      ...(executionIds.length
        ? (
            await this.db
              .selectFrom('execution_outputs')
              .select('artifact_id')
              .where('execution_id', 'in', executionIds)
              .orderBy('artifact_id')
              .execute()
          ).map((output) => output.artifact_id)
        : []),
      ...(executionIds.length
        ? (
            await this.db
              .selectFrom('execution_inputs')
              .select('artifact_id')
              .where('execution_id', 'in', executionIds)
              .where('artifact_id', 'is not', null)
              .orderBy('artifact_id')
              .execute()
          ).flatMap((input) => (input.artifact_id ? [input.artifact_id] : []))
        : []),
      ...actions.map((action) => action.outbound_request_artifact_id),
    ]);
    assertWithinBound(
      artifactIds,
      limit,
      'run_details_artifact_bound_exceeded',
    );

    const derivationCandidates = artifactIds.length
      ? await this.db
          .selectFrom('artifact_derivations')
          .select([
            'id',
            'artifact_id',
            'source_artifact_id',
            'execution_id',
            'attempt_id',
            'derivation_type',
            'created_at',
          ])
          .where(({ eb, or }) =>
            or([
              eb('artifact_id', 'in', artifactIds),
              eb('source_artifact_id', 'in', artifactIds),
            ]),
          )
          .orderBy('id')
          .limit(limit + 1)
          .execute()
      : [];
    assertWithinBound(
      derivationCandidates,
      limit,
      'run_details_derivation_bound_exceeded',
    );
    const ownedArtifacts = new Set(artifactIds);
    const ownedExecutions = new Set(executionIds);
    const ownedAttempts = new Set(attemptIds);
    const derivations = derivationCandidates.filter(
      (derivation) =>
        ownedArtifacts.has(derivation.artifact_id) &&
        (derivation.source_artifact_id === null ||
          ownedArtifacts.has(derivation.source_artifact_id)) &&
        (derivation.execution_id === null ||
          ownedExecutions.has(derivation.execution_id)) &&
        (derivation.attempt_id === null ||
          ownedAttempts.has(derivation.attempt_id)),
    );

    const checkpoints = await this.db
      .selectFrom('projection_checkpoints')
      .select([
        'id',
        'projection_name',
        'stream_key',
        'last_event_id',
        'last_sequence_number',
        'updated_at',
      ])
      .where('stream_key', '=', 'global')
      .orderBy('projection_name')
      .limit(limit + 1)
      .execute();
    assertWithinBound(
      checkpoints,
      limit,
      'run_details_projection_bound_exceeded',
    );
    const generatedAt = this.now();

    return {
      runId: run.id,
      limits: { records: limit },
      approvals,
      policyDecisions,
      resources,
      derivations,
      projectionFreshness: {
        staleAfterMs: PROJECTION_STALE_AFTER_MS,
        generatedAt: generatedAt.toISOString(),
        items: checkpoints.map((checkpoint) => {
          const updatedAt = new Date(String(checkpoint.updated_at));
          const stalenessMs = Math.max(
            0,
            generatedAt.getTime() - updatedAt.getTime(),
          );
          return {
            id: checkpoint.id,
            projectionName: checkpoint.projection_name,
            streamKey: checkpoint.stream_key,
            lastEventId: checkpoint.last_event_id,
            lastSequenceNumber: checkpoint.last_sequence_number,
            updatedAt: checkpoint.updated_at,
            stalenessMs,
            stale:
              !Number.isFinite(stalenessMs) ||
              stalenessMs > PROJECTION_STALE_AFTER_MS,
          };
        }),
      },
    };
  }

  private async loadRun(runId: string): Promise<RunIdentity> {
    const run = await this.db
      .selectFrom('commands')
      .select(['id', 'correlation_id'])
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run) throw new OperatorNotFoundError('run_not_found');
    if (!run.correlation_id)
      throw new OperatorValidationError('run_missing_correlation_id');
    return { id: run.id, correlationId: run.correlation_id };
  }
}

function requireOperator(context: OperatorContext): void {
  if (
    !context.principal.roles.includes('operator') &&
    !context.principal.roles.includes('admin')
  )
    throw new OperatorAuthorizationError();
}

function normalizeLimit(value?: number): number {
  const normalized = value ?? DEFAULT_DETAIL_LIMIT;
  if (
    !Number.isInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_DETAIL_LIMIT
  )
    throw new OperatorValidationError('invalid_run_details_limit');
  return normalized;
}

function assertWithinBound<T>(
  rows: readonly T[],
  limit: number,
  code: string,
): void {
  if (rows.length > limit) throw new OperatorValidationError(code);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export const runDetailsSemantics = {
  defaultLimit: DEFAULT_DETAIL_LIMIT,
  maximumLimit: MAX_DETAIL_LIMIT,
  projectionStaleAfterMs: PROJECTION_STALE_AFTER_MS,
} as const;
