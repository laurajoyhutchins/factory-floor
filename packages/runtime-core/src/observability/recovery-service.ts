import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import {
  ArtifactRepository,
  createUuidV7,
  type Database,
  type Json,
} from '@factory-floor/db';
import type { Kysely } from 'kysely';
import {
  ArtifactReconciliationService,
  type ArtifactReconciliationReport,
} from '../artifacts/artifact-reconciliation-service.js';
import { EventService } from '../events/event-service.js';
import {
  ObservabilityService,
  PROJECTION_NAMES,
} from './observability-service.js';

const MAX_ATTEMPTS = 4;
const RECOVERY_FAILURE = {
  code: 'startup_recovery_terminal',
  message: 'Execution could not be resumed during startup recovery.',
  retryable: false,
} satisfies Json;
const CANCELLATION_FAILURE = {
  code: 'region_cancelled',
  message: 'Execution was cancelled while the control plane was offline.',
  retryable: false,
} satisfies Json;

export interface StartupRecoverySummary {
  expiredAttemptsAbandoned: number;
  replacementAttemptsCreated: number;
  retryableDeliveriesExposed: number;
  terminalExecutionsFailed: number;
  cancellingRegionsSettled: number;
  cancelledAttemptsSettled: number;
  cancelledDeliveriesSettled: number;
  projectionsResumed: number;
  artifactReconciliation: ArtifactReconciliationReport | null;
  recoveryEventId: string | null;
}

export interface StartupRecoveryDependencies {
  observability?: ObservabilityService;
  blobStore?: ArtifactBlobStore;
  clock?: () => Date;
}

export class StartupRecoveryService {
  private readonly observability: ObservabilityService;
  private readonly events: EventService;
  private readonly clock: () => Date;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly deps: StartupRecoveryDependencies = {},
  ) {
    this.observability = deps.observability ?? new ObservabilityService(db);
    this.events = new EventService(db);
    this.clock = deps.clock ?? (() => new Date());
  }

  async run(
    options: {
      now?: Date;
      projectionBatchSize?: number;
      reconciliationBatchSize?: number;
      removeOrphanArtifacts?: boolean;
      orphanGraceSeconds?: number;
    } = {},
  ): Promise<StartupRecoverySummary> {
    const now = options.now ?? this.clock();
    const expiredAttemptIds = await this.db
      .selectFrom('execution_attempts')
      .select('id')
      .where('status', 'in', ['leased', 'running'])
      .where('lease_expires_at', '<=', now)
      .orderBy('id')
      .execute();

    let expiredAttemptsAbandoned = 0;
    let replacementAttemptsCreated = 0;
    let retryableDeliveriesExposed = 0;
    let terminalExecutionsFailed = 0;

    for (const candidate of expiredAttemptIds) {
      const recovered = await this.db.transaction().execute(async (trx) => {
        const attempt = await trx
          .selectFrom('execution_attempts')
          .selectAll()
          .where('id', '=', candidate.id)
          .forUpdate()
          .executeTakeFirst();
        if (
          !attempt ||
          !['leased', 'running'].includes(attempt.status) ||
          !attempt.lease_expires_at ||
          attempt.lease_expires_at > now
        )
          return {
            abandoned: 0,
            replacement: 0,
            exposed: 0,
            terminal: 0,
          };

        const execution = await trx
          .selectFrom('executions')
          .selectAll()
          .where('id', '=', attempt.execution_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const region = await trx
          .selectFrom('regions')
          .selectAll()
          .where('id', '=', execution.region_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const inputDeliveries = await trx
          .selectFrom('execution_inputs as input')
          .innerJoin(
            'deliveries as delivery',
            'delivery.id',
            'input.delivery_id',
          )
          .select('delivery.id')
          .where('input.execution_id', '=', execution.id)
          .forUpdate()
          .execute();
        const deliveryIds = inputDeliveries.map((row) => row.id);

        await trx
          .updateTable('execution_attempts')
          .set({
            status: 'abandoned',
            completed_at: now,
            failure: null,
            lease_owner: null,
            lease_token: null,
            lease_expires_at: null,
          })
          .where('id', '=', attempt.id)
          .execute();

        if (
          execution.status === 'running' &&
          region.lifecycle_status === 'running' &&
          attempt.attempt_number < MAX_ATTEMPTS
        ) {
          const replacement = await trx
            .insertInto('execution_attempts')
            .values({
              id: createUuidV7(),
              execution_id: execution.id,
              attempt_number: attempt.attempt_number + 1,
              status: 'pending',
              started_at: now,
              failure: null,
            } as never)
            .onConflict((conflict) =>
              conflict.columns(['execution_id', 'attempt_number']).doNothing(),
            )
            .returning('id')
            .executeTakeFirst();
          if (deliveryIds.length > 0)
            await trx
              .updateTable('deliveries')
              .set({
                status: 'ready',
                available_at: now as never,
                lease_owner: null,
                lease_token: null,
                lease_expires_at: null,
              })
              .where('id', 'in', deliveryIds)
              .execute();
          return {
            abandoned: 1,
            replacement: replacement ? 1 : 0,
            exposed: deliveryIds.length,
            terminal: 0,
          };
        }

        if (execution.status === 'running') {
          await trx
            .updateTable('executions')
            .set({
              status: 'failed',
              failed_at: now,
              completed_at: null,
              failure: RECOVERY_FAILURE,
            })
            .where('id', '=', execution.id)
            .execute();
          if (deliveryIds.length > 0)
            await trx
              .updateTable('deliveries')
              .set({
                status: 'dead_lettered',
                lease_owner: null,
                lease_token: null,
                lease_expires_at: null,
                dead_lettered_at: now,
              } as never)
              .where('id', 'in', deliveryIds)
              .execute();
          return {
            abandoned: 1,
            replacement: 0,
            exposed: 0,
            terminal: 1,
          };
        }

        return {
          abandoned: 1,
          replacement: 0,
          exposed: 0,
          terminal: 0,
        };
      });
      expiredAttemptsAbandoned += recovered.abandoned;
      replacementAttemptsCreated += recovered.replacement;
      retryableDeliveriesExposed += recovered.exposed;
      terminalExecutionsFailed += recovered.terminal;
    }

    const orphanedDeliveries = await this.db
      .updateTable('deliveries')
      .set({
        status: 'ready',
        available_at: now as never,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
      })
      .where('status', '=', 'leased')
      .where('lease_expires_at', '<=', now)
      .where(
        'region_id',
        'in',
        this.db
          .selectFrom('regions')
          .select('id')
          .where('lifecycle_status', '=', 'running'),
      )
      .executeTakeFirst();
    retryableDeliveriesExposed += Number(
      orphanedDeliveries.numUpdatedRows ?? 0n,
    );

    const cancellingRegionIds = await this.db
      .selectFrom('regions')
      .select('id')
      .where('lifecycle_status', '=', 'cancelling')
      .orderBy('id')
      .execute();
    let cancellingRegionsSettled = 0;
    let cancelledAttemptsSettled = 0;
    let cancelledDeliveriesSettled = 0;

    for (const candidate of cancellingRegionIds) {
      const settled = await this.db.transaction().execute(async (trx) => {
        const region = await trx
          .selectFrom('regions')
          .selectAll()
          .where('id', '=', candidate.id)
          .forUpdate()
          .executeTakeFirst();
        if (!region || region.lifecycle_status !== 'cancelling')
          return { region: 0, attempts: 0, deliveries: 0 };

        const attemptResult = await trx
          .updateTable('execution_attempts')
          .set({
            status: 'cancelled',
            completed_at: now,
            failure: null,
            lease_owner: null,
            lease_token: null,
            lease_expires_at: null,
          })
          .where('status', 'in', ['pending', 'leased', 'running'])
          .where(
            'execution_id',
            'in',
            trx
              .selectFrom('executions')
              .select('id')
              .where('region_id', '=', region.id),
          )
          .executeTakeFirst();
        await trx
          .updateTable('executions')
          .set({
            status: 'failed',
            failed_at: now,
            completed_at: null,
            failure: CANCELLATION_FAILURE,
          })
          .where('region_id', '=', region.id)
          .where('status', '=', 'running')
          .execute();
        const deliveryResult = await trx
          .updateTable('deliveries')
          .set({
            status: 'cancelled',
            lease_owner: null,
            lease_token: null,
            lease_expires_at: null,
          })
          .where('region_id', '=', region.id)
          .where('status', 'in', ['ready', 'leased'])
          .executeTakeFirst();
        await trx
          .updateTable('regions')
          .set({
            lifecycle_status: 'cancelled',
            lifecycle_epoch: region.lifecycle_epoch + 1,
          })
          .where('id', '=', region.id)
          .execute();
        return {
          region: 1,
          attempts: Number(attemptResult.numUpdatedRows ?? 0n),
          deliveries: Number(deliveryResult.numUpdatedRows ?? 0n),
        };
      });
      cancellingRegionsSettled += settled.region;
      cancelledAttemptsSettled += settled.attempts;
      cancelledDeliveriesSettled += settled.deliveries;
    }

    const artifactReconciliation = await this.reconcileArtifacts({
      batchSize: options.reconciliationBatchSize ?? 500,
      removeOrphans: options.removeOrphanArtifacts ?? false,
      orphanGraceSeconds: options.orphanGraceSeconds ?? 3600,
    });

    const rootRegion = await this.db
      .selectFrom('regions')
      .select('id')
      .where('parent_region_id', 'is', null)
      .orderBy('id')
      .executeTakeFirst();
    const recoveryPayload: Json = {
      expiredAttemptsAbandoned,
      replacementAttemptsCreated,
      retryableDeliveriesExposed,
      terminalExecutionsFailed,
      cancellingRegionsSettled,
      cancelledAttemptsSettled,
      cancelledDeliveriesSettled,
      artifactReconciliation:
        artifactReconciliation === null
          ? null
          : (JSON.parse(JSON.stringify(artifactReconciliation)) as Json),
      projectorVersion: 'task10.v2',
      projectionsExpected: PROJECTION_NAMES.length,
      completedAt: now.toISOString(),
    };
    const recoveryEvent = rootRegion
      ? await this.events.insert(this.db, {
          regionId: rootRegion.id,
          eventType: 'runtime.recovery.completed',
          payload: recoveryPayload,
          streamKey: 'runtime:recovery',
          sourceKind: 'system',
        })
      : null;

    const projections = await this.observability.rebuildProjections(
      options.projectionBatchSize ?? 500,
    );
    return {
      expiredAttemptsAbandoned,
      replacementAttemptsCreated,
      retryableDeliveriesExposed,
      terminalExecutionsFailed,
      cancellingRegionsSettled,
      cancelledAttemptsSettled,
      cancelledDeliveriesSettled,
      projectionsResumed: projections.checkpointed,
      artifactReconciliation,
      recoveryEventId: recoveryEvent?.id ?? null,
    };
  }

  private async reconcileArtifacts(input: {
    batchSize: number;
    removeOrphans: boolean;
    orphanGraceSeconds: number;
  }): Promise<ArtifactReconciliationReport | null> {
    if (!this.deps.blobStore) return null;
    const service = new ArtifactReconciliationService({
      db: this.db,
      repository: new ArtifactRepository(),
      blobStore: this.deps.blobStore,
      clock: this.clock,
    });
    let cursor: string | undefined;
    let batches = 0;
    const aggregate: ArtifactReconciliationReport = {
      dryRun: false,
      scanned: 0,
      promoted: 0,
      wouldPromote: 0,
      alreadyConsistent: 0,
      abandonedMetadataRows: 0,
      wouldAbandonMetadataRows: 0,
      orphanStagedObjects: 0,
      removedOrphanObjects: 0,
      wouldRemoveOrphanObjects: 0,
      unresolved: [],
    };
    do {
      const report = await service.runBatch({
        limit: input.batchSize,
        cursor,
        removeOrphans: input.removeOrphans,
        orphanGraceSeconds: input.orphanGraceSeconds,
      });
      aggregate.scanned += report.scanned;
      aggregate.promoted += report.promoted;
      aggregate.wouldPromote += report.wouldPromote;
      aggregate.alreadyConsistent += report.alreadyConsistent;
      aggregate.abandonedMetadataRows += report.abandonedMetadataRows;
      aggregate.wouldAbandonMetadataRows += report.wouldAbandonMetadataRows;
      aggregate.orphanStagedObjects += report.orphanStagedObjects;
      aggregate.removedOrphanObjects += report.removedOrphanObjects;
      aggregate.wouldRemoveOrphanObjects += report.wouldRemoveOrphanObjects;
      aggregate.unresolved.push(...report.unresolved);
      cursor = report.nextCursor;
      batches += 1;
    } while (cursor && batches < 100);
    if (cursor) aggregate.nextCursor = cursor;
    return aggregate;
  }
}
