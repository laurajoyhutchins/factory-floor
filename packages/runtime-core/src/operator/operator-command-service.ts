import { canonicalJsonDigest } from '../declarations/canonical-json.js';
import { CommandService } from '../commands/command-service.js';
import { EventService } from '../events/event-service.js';
import {
  createUuidV7,
  type Database,
  type Json,
  type RuntimeDb,
} from '@factory-floor/db';
import type { Kysely } from 'kysely';
import {
  OperatorAuthorizationError,
  OperatorConflictError,
  OperatorNotFoundError,
  OperatorValidationError,
} from './errors.js';
import type {
  ApprovalDecisionRequest,
  DevelopmentTaskRequest,
  OperatorContext,
  RunCancellationRequest,
} from './types.js';

const TERMINAL_DELIVERY_STATUSES = ['completed', 'failed', 'cancelled', 'dead_lettered'];
const TERMINAL_EXECUTION_STATUSES = ['completed', 'failed', 'cancelled'];
const TERMINAL_ATTEMPT_STATUSES = ['completed', 'failed', 'cancelled'];

export class OperatorCommandService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly commands = new CommandService(db),
    private readonly events = new EventService(db),
    private readonly clock = () => new Date(),
  ) {}

  async submitDevelopmentTask(
    context: OperatorContext,
    input: DevelopmentTaskRequest,
  ) {
    requireOperator(context);
    validateDevelopmentTask(input);
    const result = await this.commands.submit({
      region: 'investigation',
      commandType: 'development.task.requested',
      source: operatorSource(context),
      payload: {
        repository: input.repository,
        objective: input.objective.trim(),
        acceptanceCriteria: input.acceptanceCriteria.map((item) => item.trim()),
        authority: {
          mayCreateBranch: input.authority?.mayCreateBranch === true,
          mayOpenDraftPullRequest:
            input.authority?.mayOpenDraftPullRequest === true,
          mayMerge: false,
        },
        metadata: input.metadata ?? {},
      } as Json,
      correlationId: input.clientRequestId,
      idempotencyKey: `${context.principal.id}:development-task:${input.clientRequestId}`,
    });
    const command = await this.db
      .selectFrom('commands as command')
      .innerJoin('regions as region', 'region.id', 'command.region_id')
      .select(['command.id', 'region.id as region_id', 'region.name as region_name'])
      .where('command.id', '=', result.commandId)
      .executeTakeFirstOrThrow();
    return {
      runId: result.commandId,
      commandId: result.commandId,
      regionId: command.region_id,
      regionName: command.region_name,
      status: result.status,
      disposition: result.disposition,
      rejection: result.rejection,
    };
  }

  async decideApproval(
    context: OperatorContext,
    approvalId: string,
    input: ApprovalDecisionRequest,
  ) {
    requireOperator(context);
    requireClientRequestId(input.clientRequestId);
    const reason = requireReason(input.reason);
    if (input.decision !== 'approve' && input.decision !== 'reject')
      throw new OperatorValidationError('invalid_decision');
    const digest = canonicalJsonDigest({
      approvalId,
      clientRequestId: input.clientRequestId,
      decision: input.decision,
      reason,
    });

    return this.db.transaction().execute(async (transaction) => {
      const reusedRequest = await transaction
        .selectFrom('approvals')
        .select(['id', 'decision_request_digest'])
        .where('decided_by', '=', context.principal.id)
        .where('decision_client_request_id', '=', input.clientRequestId)
        .executeTakeFirst();
      if (reusedRequest && reusedRequest.id !== approvalId)
        throw new OperatorConflictError('approval_idempotency_conflict');

      const approval = await transaction
        .selectFrom('approvals')
        .selectAll()
        .where('id', '=', approvalId)
        .forUpdate()
        .executeTakeFirst();
      if (!approval) throw new OperatorNotFoundError('approval_not_found');
      if (approval.status !== 'requested') {
        if (
          approval.decided_by === context.principal.id &&
          approval.decision_client_request_id === input.clientRequestId &&
          approval.decision_request_digest === digest
        )
          return approvalReceipt(
            approvalId,
            context,
            input,
            approval.decision_reason ?? reason,
            'replayed',
          );
        throw new OperatorConflictError('approval_not_pending');
      }

      const action = await transaction
        .selectFrom('external_actions')
        .selectAll()
        .where('approval_id', '=', approvalId)
        .forUpdate()
        .executeTakeFirst();
      if (action && action.status !== 'awaiting_approval')
        throw new OperatorConflictError('approval_context_changed');

      await transaction
        .updateTable('approvals')
        .set({
          status: input.decision === 'approve' ? 'approved' : 'denied',
          decided_at: this.clock(),
          decided_by: context.principal.id,
          decision_reason: reason,
          decision_client_request_id: input.clientRequestId,
          decision_request_digest: digest,
        })
        .where('id', '=', approvalId)
        .executeTakeFirstOrThrow();
      if (action)
        await transaction
          .updateTable('external_actions')
          .set({
            status: input.decision === 'approve' ? 'authorized' : 'denied',
          })
          .where('id', '=', action.id)
          .executeTakeFirstOrThrow();

      return approvalReceipt(
        approvalId,
        context,
        input,
        reason,
        'accepted',
      );
    });
  }

  async cancelRun(
    context: OperatorContext,
    runId: string,
    input: RunCancellationRequest,
  ) {
    requireOperator(context);
    requireClientRequestId(input.clientRequestId);
    const reason = requireReason(input.reason);
    const requestDigest = canonicalJsonDigest({
      runId,
      clientRequestId: input.clientRequestId,
      reason,
    });

    return this.db.transaction().execute(async (transaction) => {
      const run = await transaction
        .selectFrom('commands')
        .selectAll()
        .where('id', '=', runId)
        .forUpdate()
        .executeTakeFirst();
      if (!run) throw new OperatorNotFoundError('run_not_found');
      const idempotencyKey = `${context.principal.id}:operator-cancel:${input.clientRequestId}`;
      const existing = await transaction
        .selectFrom('commands')
        .selectAll()
        .where('region_id', '=', run.region_id)
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.request_digest !== requestDigest)
          throw new OperatorConflictError('cancellation_idempotency_conflict');
        return this.cancellationReceipt(
          transaction,
          run,
          input.clientRequestId,
          'replayed',
        );
      }

      const cancellationCommandId = createUuidV7();
      const now = this.clock();
      await transaction
        .insertInto('commands')
        .values({
          id: cancellationCommandId,
          region_id: run.region_id,
          command_type: 'operator.run.cancel_requested',
          payload: { runId, reason } as Json,
          status: 'accepted',
          source: operatorSource(context),
          request_digest: requestDigest,
          rejection: null,
          accepted_at: now,
          rejected_at: null,
          correlation_id: input.clientRequestId,
          idempotency_key: idempotencyKey,
          expires_at: null,
        })
        .executeTakeFirstOrThrow();
      await this.events.insert(transaction, {
        regionId: run.region_id,
        eventType: 'operator.run.cancel_requested',
        payload: { runId, reason },
        streamKey: `region:${run.region_id}:commands`,
        correlationId: input.clientRequestId,
        sourceKind: 'command',
        sourceCommandId: cancellationCommandId,
      });

      const deliveries = await transaction
        .selectFrom('deliveries')
        .select(['id', 'status'])
        .where('region_id', '=', run.region_id)
        .where('correlation_id', '=', run.correlation_id)
        .forUpdate()
        .execute();
      const deliveryIds = deliveries.map((delivery) => delivery.id);
      const executions = deliveryIds.length
        ? await transaction
            .selectFrom('executions')
            .select(['id', 'status'])
            .where('delivery_id', 'in', deliveryIds)
            .forUpdate()
            .execute()
        : [];
      const executionIds = executions.map((execution) => execution.id);
      const attempts = executionIds.length
        ? await transaction
            .selectFrom('execution_attempts')
            .select(['id', 'status'])
            .where('execution_id', 'in', executionIds)
            .forUpdate()
            .execute()
        : [];

      const cancellableAttemptIds = attempts
        .filter((attempt) => !TERMINAL_ATTEMPT_STATUSES.includes(attempt.status))
        .map((attempt) => attempt.id);
      if (cancellableAttemptIds.length)
        await transaction
          .updateTable('execution_attempts')
          .set({
            status: 'cancelled',
            lease_owner: null,
            lease_token: null,
            lease_expires_at: null,
            completed_at: now,
          })
          .where('id', 'in', cancellableAttemptIds)
          .execute();

      const cancellableExecutionIds = executions
        .filter(
          (execution) =>
            !TERMINAL_EXECUTION_STATUSES.includes(execution.status),
        )
        .map((execution) => execution.id);
      if (cancellableExecutionIds.length)
        await transaction
          .updateTable('executions')
          .set({ status: 'cancelled', completed_at: now })
          .where('id', 'in', cancellableExecutionIds)
          .execute();

      const cancellableDeliveryIds = deliveries
        .filter(
          (delivery) => !TERMINAL_DELIVERY_STATUSES.includes(delivery.status),
        )
        .map((delivery) => delivery.id);
      if (cancellableDeliveryIds.length)
        await transaction
          .updateTable('deliveries')
          .set({
            status: 'cancelled',
            lease_owner: null,
            lease_token: null,
            lease_expires_at: null,
          })
          .where('id', 'in', cancellableDeliveryIds)
          .execute();

      return {
        runId,
        cancellationCommandId,
        clientRequestId: input.clientRequestId,
        disposition: 'accepted' as const,
        cancelledDeliveries: cancellableDeliveryIds.length,
        cancelledExecutions: cancellableExecutionIds.length,
        cancelledAttempts: cancellableAttemptIds.length,
      };
    });
  }

  private async cancellationReceipt(
    db: RuntimeDb,
    run: Database['commands'],
    clientRequestId: string,
    disposition: 'replayed',
  ) {
    const deliveries = await db
      .selectFrom('deliveries')
      .select(['id', 'status'])
      .where('region_id', '=', run.region_id)
      .where('correlation_id', '=', run.correlation_id)
      .execute();
    const deliveryIds = deliveries.map((delivery) => delivery.id);
    const executions = deliveryIds.length
      ? await db
          .selectFrom('executions')
          .select(['id', 'status'])
          .where('delivery_id', 'in', deliveryIds)
          .execute()
      : [];
    const executionIds = executions.map((execution) => execution.id);
    const attempts = executionIds.length
      ? await db
          .selectFrom('execution_attempts')
          .select(['id', 'status'])
          .where('execution_id', 'in', executionIds)
          .execute()
      : [];
    return {
      runId: run.id,
      clientRequestId,
      disposition,
      cancelledDeliveries: deliveries.filter(
        (delivery) => delivery.status === 'cancelled',
      ).length,
      cancelledExecutions: executions.filter(
        (execution) => execution.status === 'cancelled',
      ).length,
      cancelledAttempts: attempts.filter(
        (attempt) => attempt.status === 'cancelled',
      ).length,
    };
  }
}

function requireOperator(context: OperatorContext) {
  if (
    !context.principal.roles.includes('operator') &&
    !context.principal.roles.includes('admin')
  )
    throw new OperatorAuthorizationError();
}

function operatorSource(context: OperatorContext): Json {
  return {
    kind: 'operator',
    adapter: context.adapter?.trim() || 'operator-api',
    principalId: context.principal.id,
  };
}

function requireClientRequestId(value: string) {
  if (!value?.trim()) throw new OperatorValidationError('client_request_id_required');
}

function requireReason(value: string) {
  const reason = value?.trim();
  if (!reason) throw new OperatorValidationError('reason_required');
  if (reason.length > 1_000)
    throw new OperatorValidationError('reason_too_long');
  return reason;
}

function validateDevelopmentTask(input: DevelopmentTaskRequest) {
  requireClientRequestId(input.clientRequestId);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
    throw new OperatorValidationError('invalid_repository');
  if (!input.objective?.trim())
    throw new OperatorValidationError('objective_required');
  if (input.objective.length > 4_000)
    throw new OperatorValidationError('objective_too_long');
  if (
    !Array.isArray(input.acceptanceCriteria) ||
    input.acceptanceCriteria.length < 1 ||
    input.acceptanceCriteria.length > 20 ||
    input.acceptanceCriteria.some(
      (criterion) => !criterion?.trim() || criterion.length > 500,
    )
  )
    throw new OperatorValidationError('invalid_acceptance_criteria');
  if (input.authority && input.authority.mayMerge !== undefined)
    throw new OperatorValidationError('merge_authority_not_supported');
}

function approvalReceipt(
  approvalId: string,
  context: OperatorContext,
  input: ApprovalDecisionRequest,
  reason: string,
  disposition: 'accepted' | 'replayed',
) {
  return {
    approvalId,
    decision: input.decision,
    status: 'recorded' as const,
    principalId: context.principal.id,
    reason,
    clientRequestId: input.clientRequestId,
    disposition,
  };
}
