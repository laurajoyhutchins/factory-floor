import type { Kysely } from 'kysely';
import { createUuidV7, type Database, type Json } from '@factory-floor/db';

export interface ExternalActionProviderRequest {
  readonly actionId: string;
  readonly actionType: string;
  readonly idempotencyKey: string;
  readonly capabilityGrantId: string;
  readonly outboundRequestArtifactId: string;
}

export type ExternalActionProviderResult =
  | { readonly status: 'acknowledged'; readonly response: Json }
  | { readonly status: 'failed'; readonly response: Json }
  | { readonly status: 'indeterminate'; readonly response: Json };

export interface ExternalActionProvider {
  dispatch(
    request: ExternalActionProviderRequest,
  ): Promise<ExternalActionProviderResult>;
  reconcile(
    request: ExternalActionProviderRequest,
  ): Promise<ExternalActionProviderResult>;
}

export class ExternalActionIndeterminateError extends Error {
  constructor(
    message: string,
    readonly response: Json = {
      code: 'external_action_response_lost',
      message,
    },
  ) {
    super(message);
    this.name = 'ExternalActionIndeterminateError';
  }
}

export class ExternalActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExternalActionError';
  }
}

export interface ExternalActionReconciliationReport {
  scanned: number;
  reconciled: number;
  failed: number;
  indeterminate: number;
}

type DispatchPreparation =
  | {
      disposition: 'dispatch';
      request: ExternalActionProviderRequest;
      attemptId: string;
    }
  | { disposition: 'reconcile' }
  | { disposition: 'cancelled' | 'terminal' };

export class ExternalActionService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly provider: ExternalActionProvider,
    private readonly clock = () => new Date(),
  ) {}

  async dispatch(actionId: string) {
    const prepared = await this.prepareDispatch(actionId);
    if (prepared.disposition === 'reconcile') return this.reconcile(actionId);
    if (prepared.disposition !== 'dispatch') return prepared;

    try {
      const result = await this.provider.dispatch(prepared.request);
      return this.persistDispatchResult(actionId, prepared.attemptId, result);
    } catch (error) {
      if (!(error instanceof ExternalActionIndeterminateError)) throw error;
      return this.persistDispatchResult(actionId, prepared.attemptId, {
        status: 'indeterminate',
        response: error.response,
      });
    }
  }

  async reconcile(actionId: string) {
    const current = await this.db.transaction().execute(async (trx) => {
      const action = await trx
        .selectFrom('external_actions')
        .selectAll()
        .where('id', '=', actionId)
        .forUpdate()
        .executeTakeFirst();
      if (!action)
        throw new ExternalActionError(
          'external_action_not_found',
          'external action was not found',
        );
      if (action.status === 'reconciled')
        return { disposition: 'terminal' as const, status: action.status };
      if (
        !['dispatching', 'indeterminate', 'acknowledged'].includes(
          action.status,
        )
      )
        return { disposition: 'terminal' as const, status: action.status };

      const attempt = await trx
        .selectFrom('external_action_attempts')
        .selectAll()
        .where('external_action_id', '=', action.id)
        .orderBy('attempt_number', 'desc')
        .forUpdate()
        .executeTakeFirst();
      if (!attempt)
        throw new ExternalActionError(
          'external_action_attempt_missing',
          'uncertain external action has no durable attempt',
        );
      return {
        disposition: 'reconcile' as const,
        attemptId: attempt.id,
        request: this.providerRequest(action),
      };
    });

    if (current.disposition === 'terminal') return current;
    const result = await this.provider.reconcile(current.request);
    return this.persistReconciliationResult(
      actionId,
      current.attemptId,
      result,
    );
  }

  async reconcilePending(
    limit = 100,
  ): Promise<ExternalActionReconciliationReport> {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError(
        'external action reconciliation limit must be positive',
      );
    const candidates = await this.db
      .selectFrom('external_actions')
      .select('id')
      .where('status', 'in', ['dispatching', 'indeterminate', 'acknowledged'])
      .orderBy('created_at')
      .orderBy('id')
      .limit(limit)
      .execute();
    const report: ExternalActionReconciliationReport = {
      scanned: 0,
      reconciled: 0,
      failed: 0,
      indeterminate: 0,
    };
    for (const candidate of candidates) {
      report.scanned++;
      const result = await this.reconcile(candidate.id);
      if (result.status === 'reconciled') report.reconciled++;
      else if (result.status === 'failed') report.failed++;
      else if (result.status === 'indeterminate') report.indeterminate++;
    }
    return report;
  }

  private async prepareDispatch(
    actionId: string,
  ): Promise<DispatchPreparation> {
    return this.db.transaction().execute(async (trx) => {
      const action = await trx
        .selectFrom('external_actions as action')
        .innerJoin(
          'executions as execution',
          'execution.id',
          'action.execution_id',
        )
        .innerJoin('regions as region', 'region.id', 'execution.region_id')
        .select([
          'action.id',
          'action.action_type',
          'action.idempotency_key',
          'action.capability_grant_id',
          'action.outbound_request_artifact_id',
          'action.status',
          'execution.lifecycle_epoch as execution_lifecycle_epoch',
          'region.lifecycle_epoch as region_lifecycle_epoch',
          'region.lifecycle_status',
        ])
        .where('action.id', '=', actionId)
        .forUpdate()
        .executeTakeFirst();
      if (!action)
        throw new ExternalActionError(
          'external_action_not_found',
          'external action was not found',
        );
      if (
        ['dispatching', 'indeterminate', 'acknowledged'].includes(action.status)
      )
        return { disposition: 'reconcile' };
      if (action.status !== 'authorized') return { disposition: 'terminal' };
      if (
        action.lifecycle_status !== 'running' ||
        action.execution_lifecycle_epoch !== action.region_lifecycle_epoch
      ) {
        await trx
          .updateTable('external_actions')
          .set({ status: 'cancelled' })
          .where('id', '=', action.id)
          .execute();
        return { disposition: 'cancelled' };
      }

      const previous = await trx
        .selectFrom('external_action_attempts')
        .select(({ fn }) =>
          fn.max<number>('attempt_number').as('attempt_number'),
        )
        .where('external_action_id', '=', action.id)
        .executeTakeFirst();
      const attemptNumber = Number(previous?.attempt_number ?? 0) + 1;
      const attemptId = createUuidV7();
      await trx
        .insertInto('external_action_attempts')
        .values({
          id: attemptId,
          external_action_id: action.id,
          attempt_number: attemptNumber,
          status: 'dispatching',
          requested_at: this.clock(),
          completed_at: null,
          response: null,
        })
        .execute();
      await trx
        .updateTable('external_actions')
        .set({ status: 'dispatching' })
        .where('id', '=', action.id)
        .execute();
      return {
        disposition: 'dispatch',
        attemptId,
        request: this.providerRequest(action),
      };
    });
  }

  private async persistDispatchResult(
    actionId: string,
    attemptId: string,
    result: ExternalActionProviderResult,
  ) {
    const actionStatus = result.status;
    await this.persistResult(
      actionId,
      attemptId,
      actionStatus,
      result.response,
    );
    return { disposition: 'dispatched' as const, status: actionStatus };
  }

  private async persistReconciliationResult(
    actionId: string,
    attemptId: string,
    result: ExternalActionProviderResult,
  ) {
    const actionStatus =
      result.status === 'acknowledged' ? 'reconciled' : result.status;
    await this.persistResult(
      actionId,
      attemptId,
      actionStatus,
      result.response,
    );
    return { disposition: 'reconciled' as const, status: actionStatus };
  }

  private async persistResult(
    actionId: string,
    attemptId: string,
    actionStatus: 'acknowledged' | 'reconciled' | 'failed' | 'indeterminate',
    response: Json,
  ) {
    await this.db.transaction().execute(async (trx) => {
      const action = await trx
        .selectFrom('external_actions')
        .select('status')
        .where('id', '=', actionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const attempt = await trx
        .selectFrom('external_action_attempts')
        .select('status')
        .where('id', '=', attemptId)
        .where('external_action_id', '=', actionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (action.status === 'reconciled') return;
      if (
        !['dispatching', 'indeterminate', 'acknowledged'].includes(
          action.status,
        )
      )
        throw new ExternalActionError(
          'external_action_state_conflict',
          `external action cannot complete from ${action.status}`,
        );
      if (
        !['dispatching', 'indeterminate', 'acknowledged'].includes(
          attempt.status,
        )
      )
        throw new ExternalActionError(
          'external_action_attempt_state_conflict',
          `external action attempt cannot complete from ${attempt.status}`,
        );

      const attemptStatus =
        actionStatus === 'reconciled' ? 'acknowledged' : actionStatus;
      await trx
        .updateTable('external_action_attempts')
        .set({
          status: attemptStatus,
          completed_at: this.clock(),
          response,
        })
        .where('id', '=', attemptId)
        .execute();
      await trx
        .updateTable('external_actions')
        .set({ status: actionStatus })
        .where('id', '=', actionId)
        .execute();
    });
  }

  private providerRequest(action: {
    id: string;
    action_type: string;
    idempotency_key: string;
    capability_grant_id: string;
    outbound_request_artifact_id: string;
  }): ExternalActionProviderRequest {
    return {
      actionId: action.id,
      actionType: action.action_type,
      idempotencyKey: action.idempotency_key,
      capabilityGrantId: action.capability_grant_id,
      outboundRequestArtifactId: action.outbound_request_artifact_id,
    };
  }
}
