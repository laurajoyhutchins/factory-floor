/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Kysely } from 'kysely';
import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import {
  ArtifactRepository,
  createUuidV7,
  type Database,
  type Json,
  type RuntimeDb,
} from '@factory-floor/db';
import { ArtifactValidationService } from '../artifacts/artifact-validation-service.js';
import { canonicalJsonDigest } from '../declarations/canonical-json.js';
import { EventService } from '../events/event-service.js';
import { RoutingService } from '../routing/routing-service.js';

const RETRY_BACKOFF_MS = [1_000, 5_000, 30_000] as const;
const RESOURCE_UNITS = {
  cpuMilliseconds: 'milliseconds',
  wallMilliseconds: 'milliseconds',
  inputBytes: 'bytes',
  outputBytes: 'bytes',
  externalCalls: 'count',
} as const;

type ResourceType = keyof typeof RESOURCE_UNITS;
type Staged = {
  stagingId: string;
  portName: string;
  digest: string;
  sizeBytes: number;
  mediaType: string;
  schemaId: string;
  schemaDigest: string;
  provenance: Json;
};
type ProposedEvent = {
  eventType: string;
  subject: string;
  payload: Json;
  schemaId: string;
  schemaDigest: string;
  occurredAt: string;
  source: Json;
};
export type ProposedExecutionResult = {
  protocolVersion: '1.0';
  executionId: string;
  attemptId: string;
  leaseToken: string;
  lifecycleEpoch: number;
  status: 'completed' | 'failed' | 'cancelled';
  stagedArtifacts: Staged[];
  proposedState?: Staged;
  proposedEvents: ProposedEvent[];
  externalActionProposals: Json[];
  resourceUsage: Record<ResourceType, number>;
  failure?: Json;
};
type Promotion = {
  rowId: string;
  stagedRef: string;
  artifactId: string;
  digest: string;
  size: bigint;
};

export class ExecutionCommitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'ExecutionCommitError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExecutionSource(value: Json, executionId: string, attemptId: string) {
  return (
    isRecord(value) &&
    value.kind === 'execution' &&
    value.executionId === executionId &&
    value.attemptId === attemptId
  );
}

export class ExecutionCommitService {
  private readonly artifacts = new ArtifactRepository();
  private readonly events: EventService;
  private readonly routing: RoutingService;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly blobStore: ArtifactBlobStore | undefined,
    private readonly clock = () => new Date(),
  ) {
    this.events = new EventService(db);
    this.routing = new RoutingService(db);
  }

  async commitSubmittedResult(attemptId: string) {
    const submission = await this.db
      .selectFrom('worker_result_submissions')
      .selectAll()
      .where('attempt_id', '=', attemptId)
      .executeTakeFirstOrThrow();
    return this.commit(
      submission.result as unknown as ProposedExecutionResult,
      submission.submission_digest,
    );
  }

  async commit(
    input: ProposedExecutionResult,
    submissionDigest = canonicalJsonDigest(input),
  ) {
    const promotions: Promotion[] = [];
    let result;
    try {
      result = await this.db.transaction().execute(async (trx) => {
        const attempt = await trx
          .selectFrom('execution_attempts')
          .selectAll()
          .where('id', '=', input.attemptId)
          .where('execution_id', '=', input.executionId)
          .forUpdate()
          .executeTakeFirst();
        const execution = await trx
          .selectFrom('executions')
          .selectAll()
          .where('id', '=', input.executionId)
          .forUpdate()
          .executeTakeFirst();
        if (!attempt || !execution)
          throw new ExecutionCommitError('inactive_attempt', 'attempt is not active');

        const submission = await trx
          .selectFrom('worker_result_submissions')
          .selectAll()
          .where('attempt_id', '=', input.attemptId)
          .forUpdate()
          .executeTakeFirst();
        if (submission && submission.submission_digest !== submissionDigest)
          throw new ExecutionCommitError(
            'duplicate_conflicting_result',
            'attempt already has a different proposed result',
          );
        if (!['leased', 'running'].includes(attempt.status)) {
          if (submission) return { disposition: 'duplicate' as const };
          throw new ExecutionCommitError('inactive_attempt', 'attempt is already terminal');
        }
        if (execution.status !== 'running') {
          if (submission) return { disposition: 'duplicate' as const };
          throw new ExecutionCommitError('inactive_attempt', 'execution is already terminal');
        }

        const region = await trx
          .selectFrom('regions')
          .selectAll()
          .where('id', '=', execution.region_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const component = await trx
          .selectFrom('component_instances')
          .selectAll()
          .where('id', '=', execution.component_instance_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await trx
          .selectFrom('topology_revisions')
          .select('id')
          .where('id', '=', execution.topology_revision_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const deliveries = await trx
          .selectFrom('execution_inputs as input')
          .innerJoin('deliveries as delivery', 'delivery.id', 'input.delivery_id')
          .select([
            'delivery.id',
            'delivery.status',
            'delivery.lease_token',
            'delivery.correlation_id',
          ])
          .where('input.execution_id', '=', execution.id)
          .orderBy('delivery.id')
          .forUpdate()
          .execute();
        if (deliveries.length === 0)
          throw new ExecutionCommitError('inactive_attempt', 'execution has no inputs');

        this.assertAuthority(input, attempt, execution, region, deliveries);
        this.validateResourceUsage(input.resourceUsage);
        this.validateProposedEvents(input);
        if (input.externalActionProposals.length > 0)
          throw new ExecutionCommitError(
            'external_action_unauthorized',
            'no capability handles were issued for this invocation',
            403,
          );
        if (!submission)
          await trx
            .insertInto('worker_result_submissions')
            .values({
              id: createUuidV7(),
              execution_id: input.executionId,
              attempt_id: input.attemptId,
              submission_digest: submissionDigest,
              result: input as unknown as Json,
            })
            .execute();

        const ports = await trx
          .selectFrom('port_definitions')
          .selectAll()
          .where('component_definition_id', '=', component.component_definition_id)
          .execute();
        const artifactIds = new Map<string, string>();
        const seen = new Set<string>();
        for (const staged of input.stagedArtifacts) {
          const row = await this.validateStaged(
            trx,
            input,
            staged,
            ports,
            'output',
            seen,
          );
          if (input.status === 'completed')
            artifactIds.set(
              staged.stagingId,
              await this.publishArtifact(
                trx,
                input,
                staged,
                row,
                'execution_output',
                promotions,
              ),
            );
        }
        if (input.proposedState) {
          const row = await this.validateStaged(
            trx,
            input,
            input.proposedState,
            ports,
            'state',
            seen,
          );
          if (input.status === 'completed')
            artifactIds.set(
              input.proposedState.stagingId,
              await this.publishArtifact(
                trx,
                input,
                input.proposedState,
                row,
                'state_version',
                promotions,
              ),
            );
        }

        await this.writeResourceUsage(trx, region.id, input);
        if (input.status === 'completed')
          return this.complete(
            trx,
            input,
            execution,
            component,
            deliveries,
            artifactIds,
          );
        return this.failOrRetry(trx, input, execution, attempt, deliveries);
      });
    } catch (error) {
      if (error instanceof ExecutionCommitError && error.statusCode < 500)
        await this.db
          .deleteFrom('worker_result_submissions')
          .where('attempt_id', '=', input.attemptId)
          .where('submission_digest', '=', submissionDigest)
          .execute();
      throw error;
    }

    for (const promotion of promotions) {
      if (!this.blobStore) break;
      try {
        await this.blobStore.promote(
          promotion.stagedRef,
          promotion.digest,
          promotion.size,
        );
        await this.artifacts.markStagingPromoted(
          this.db,
          promotion.rowId,
          promotion.artifactId,
          this.clock(),
        );
      } catch {
        // ArtifactReconciliationService recovers metadata-committed blobs.
      }
    }
    return result;
  }

  private assertAuthority(
    input: ProposedExecutionResult,
    attempt: any,
    execution: any,
    region: any,
    deliveries: any[],
  ) {
    if (attempt.lease_token !== input.leaseToken)
      throw new ExecutionCommitError('stale_lease_token', 'lease token is not current');
    if (!attempt.lease_expires_at || attempt.lease_expires_at <= this.clock())
      throw new ExecutionCommitError('lease_expired', 'lease has expired');
    if (
      execution.lifecycle_epoch !== input.lifecycleEpoch ||
      region.lifecycle_epoch !== input.lifecycleEpoch ||
      region.lifecycle_status !== 'running'
    )
      throw new ExecutionCommitError(
        'stale_lifecycle_epoch',
        'lifecycle epoch is not current',
      );
    if (
      deliveries.some(
        (delivery) =>
          delivery.status !== 'leased' || delivery.lease_token !== input.leaseToken,
      )
    )
      throw new ExecutionCommitError(
        'stale_lease_token',
        'input delivery lease is not current',
      );
  }

  private validateResourceUsage(usage: Record<ResourceType, number>) {
    if (!isRecord(usage))
      throw new ExecutionCommitError(
        'invalid_resource_usage',
        'resourceUsage must be an object',
        400,
      );
    const expected = Object.keys(RESOURCE_UNITS);
    if (
      Object.keys(usage).length !== expected.length ||
      Object.keys(usage).some((key) => !expected.includes(key))
    )
      throw new ExecutionCommitError(
        'invalid_resource_usage',
        'resourceUsage must contain only canonical counters',
        400,
      );
    for (const key of expected as ResourceType[])
      if (!Number.isSafeInteger(usage[key]) || usage[key] < 0)
        throw new ExecutionCommitError(
          'invalid_resource_usage',
          `${key} must be a non-negative safe integer`,
          400,
        );
  }

  private validateProposedEvents(input: ProposedExecutionResult) {
    for (const event of input.proposedEvents)
      if (
        !event.eventType?.trim() ||
        !event.subject?.trim() ||
        !event.schemaId?.trim() ||
        !/^[a-f0-9]{64}$/.test(event.schemaDigest) ||
        Number.isNaN(Date.parse(event.occurredAt)) ||
        !isExecutionSource(event.source, input.executionId, input.attemptId)
      )
        throw new ExecutionCommitError(
          'invalid_proposed_event',
          'proposed event metadata or source is invalid',
          400,
        );
  }

  private async validateStaged(
    trx: RuntimeDb,
    input: ProposedExecutionResult,
    staged: Staged,
    ports: any[],
    direction: 'output' | 'state',
    seen: Set<string>,
  ) {
    if (seen.has(staged.stagingId))
      throw new ExecutionCommitError(
        'invalid_staged_artifact',
        'staged artifact is referenced more than once',
        400,
      );
    seen.add(staged.stagingId);
    const port = ports.find(
      (candidate) =>
        candidate.direction === direction && candidate.name === staged.portName,
    );
    if (!port)
      throw new ExecutionCommitError(
        'undeclared_output_port',
        `${direction} port ${staged.portName} is not declared`,
        400,
      );
    const row = await trx
      .selectFrom('artifact_staging as staging')
      .innerJoin('artifact_schemas as schema', 'schema.id', 'staging.schema_id')
      .select([
        'staging.id',
        'staging.staged_ref',
        'staging.attempt_id',
        'staging.digest',
        'staging.size_bytes',
        'staging.schema_id',
        'staging.media_type',
        'staging.status',
        'schema.content_digest as schema_digest',
      ])
      .where('staging.staged_ref', '=', staged.stagingId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !row ||
      row.attempt_id !== input.attemptId ||
      row.status !== 'staged' ||
      row.digest !== staged.digest ||
      row.size_bytes !== String(staged.sizeBytes) ||
      row.schema_id !== staged.schemaId ||
      port.schema_id !== staged.schemaId ||
      row.media_type !== staged.mediaType ||
      row.schema_digest !== staged.schemaDigest ||
      !isExecutionSource(staged.provenance, input.executionId, input.attemptId)
    )
      throw new ExecutionCommitError(
        'invalid_staged_artifact',
        'staged artifact metadata is not authoritative',
        400,
      );
    if (input.status === 'completed') {
      if (!this.blobStore)
        throw new ExecutionCommitError(
          'blob_store_unavailable',
          'artifact blob store is not configured',
          503,
        );
      try {
        await new ArtifactValidationService({
          db: trx,
          repository: this.artifacts,
          blobStore: this.blobStore,
          maxJsonBytes: 104_857_600n,
        }).validateStagedArtifact(row.id);
      } catch (error) {
        throw new ExecutionCommitError(
          'invalid_staged_artifact',
          error instanceof Error ? error.message : 'artifact validation failed',
          400,
        );
      }
    }
    return row;
  }

  private async publishArtifact(
    trx: RuntimeDb,
    input: ProposedExecutionResult,
    staged: Staged,
    row: any,
    derivationType: string,
    promotions: Promotion[],
  ) {
    let artifact = await this.artifacts.lockArtifactByDigest(trx, row.digest);
    if (
      artifact &&
      (artifact.size_bytes !== row.size_bytes ||
        artifact.schema_id !== row.schema_id ||
        artifact.media_type !== row.media_type ||
        artifact.state === 'tombstoned')
    )
      throw new ExecutionCommitError(
        'artifact_conflict',
        'artifact digest conflicts with existing metadata',
      );
    artifact ??= (
      await this.artifacts.createCommittedArtifactIdempotently(trx, {
        digest: row.digest,
        sizeBytes: row.size_bytes,
        schemaId: row.schema_id,
        mediaType: row.media_type,
        locator: `sha256:${row.digest}`,
        provenance: {
          executionId: input.executionId,
          attemptId: input.attemptId,
          portName: staged.portName,
          workerProvenance: staged.provenance,
        },
      })
    ).artifact;
    await this.artifacts.linkStagingRowToArtifact(trx, row.id, artifact.id);
    await trx
      .insertInto('artifact_derivations')
      .values({
        id: createUuidV7(),
        artifact_id: artifact.id,
        source_artifact_id: null,
        execution_id: input.executionId,
        attempt_id: input.attemptId,
        derivation_type: derivationType,
      })
      .execute();
    promotions.push({
      rowId: row.id,
      stagedRef: row.staged_ref,
      artifactId: artifact.id,
      digest: row.digest,
      size: BigInt(row.size_bytes),
    });
    return artifact.id;
  }

  private async writeResourceUsage(
    trx: RuntimeDb,
    regionId: string,
    input: ProposedExecutionResult,
  ) {
    for (const key of Object.keys(RESOURCE_UNITS) as ResourceType[]) {
      const quantity = input.resourceUsage[key];
      if (quantity === 0) continue;
      await trx
        .insertInto('resource_ledger')
        .values({
          id: createUuidV7(),
          region_id: regionId,
          execution_id: input.executionId,
          attempt_id: input.attemptId,
          external_action_id: null,
          resource_type: key,
          quantity: String(quantity),
          unit: RESOURCE_UNITS[key],
          attributes: {},
        })
        .execute();
    }
  }

  private async complete(
    trx: RuntimeDb,
    input: ProposedExecutionResult,
    execution: any,
    component: any,
    deliveries: any[],
    artifactIds: Map<string, string>,
  ) {
    const correlationId = deliveries[0].correlation_id;
    for (const staged of input.stagedArtifacts) {
      const artifactId = artifactIds.get(staged.stagingId)!;
      const event = await this.events.insert(trx, {
        regionId: execution.region_id,
        eventType: 'component.output',
        payload: { portName: staged.portName, artifactId },
        streamKey: `component:${component.id}:${staged.portName}`,
        correlationId,
        sourceKind: 'component',
        sourceExecutionId: input.executionId,
        sourceAttemptId: input.attemptId,
        sourceComponentInstanceId: component.id,
        sourcePortName: staged.portName,
      });
      await trx
        .insertInto('execution_outputs')
        .values({
          id: createUuidV7(),
          execution_id: input.executionId,
          attempt_id: input.attemptId,
          port_name: staged.portName,
          artifact_id: artifactId,
          published_event_id: event.id,
        })
        .execute();
      await this.routing.routeComponentEvent(
        trx,
        event,
        execution.topology_revision_id,
      );
    }
    if (input.proposedState)
      await trx
        .insertInto('execution_outputs')
        .values({
          id: createUuidV7(),
          execution_id: input.executionId,
          attempt_id: input.attemptId,
          port_name: input.proposedState.portName,
          artifact_id: artifactIds.get(input.proposedState.stagingId)!,
          published_event_id: null,
        })
        .execute();
    for (const proposed of input.proposedEvents)
      await this.events.insert(trx, {
        regionId: execution.region_id,
        eventType: proposed.eventType,
        payload: proposed.payload,
        streamKey: `subject:${proposed.subject}`,
        correlationId,
        sourceKind: 'attempt',
        sourceExecutionId: input.executionId,
        sourceAttemptId: input.attemptId,
      });

    const now = this.clock();
    await trx
      .updateTable('execution_attempts')
      .set({
        status: 'completed',
        completed_at: now,
        failure: null,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
      })
      .where('id', '=', input.attemptId)
      .execute();
    await trx
      .updateTable('executions')
      .set({ status: 'completed', completed_at: now, failed_at: null, failure: null })
      .where('id', '=', input.executionId)
      .execute();
    await trx
      .updateTable('deliveries')
      .set({
        status: 'completed',
        completed_at: now,
        failed_at: null,
        dead_lettered_at: null,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
      } as any)
      .where(
        'id',
        'in',
        deliveries.map((delivery) => delivery.id),
      )
      .execute();
    return { disposition: 'committed' as const };
  }

  private async failOrRetry(
    trx: RuntimeDb,
    input: ProposedExecutionResult,
    execution: any,
    attempt: any,
    deliveries: any[],
  ) {
    const now = this.clock();
    const failure =
      input.failure ??
      ({
        code: input.status === 'cancelled' ? 'cancelled' : 'worker_failed',
        message: `worker reported ${input.status}`,
        retryable: false,
      } as Json);
    await trx
      .updateTable('execution_attempts')
      .set({
        status: input.status === 'cancelled' ? 'cancelled' : 'failed',
        completed_at: now,
        failure,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
      })
      .where('id', '=', input.attemptId)
      .execute();

    const retryable =
      input.status === 'failed' && isRecord(failure) && failure.retryable === true;
    const delay = RETRY_BACKOFF_MS[attempt.attempt_number - 1];
    const deliveryIds = deliveries.map((delivery) => delivery.id);
    if (retryable && delay !== undefined) {
      const availableAt = new Date(now.getTime() + delay);
      await trx
        .insertInto('execution_attempts')
        .values({
          id: createUuidV7(),
          execution_id: execution.id,
          attempt_number: attempt.attempt_number + 1,
          status: 'pending',
          started_at: availableAt,
          failure: null,
        } as any)
        .onConflict((conflict) =>
          conflict.columns(['execution_id', 'attempt_number']).doNothing(),
        )
        .execute();
      await trx
        .updateTable('deliveries')
        .set({
          status: 'ready',
          available_at: availableAt,
          completed_at: null,
          failed_at: null,
          dead_lettered_at: null,
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null,
        } as any)
        .where('id', 'in', deliveryIds)
        .execute();
      return { disposition: 'retry_scheduled' as const };
    }

    await trx
      .updateTable('executions')
      .set({ status: 'failed', failed_at: now, completed_at: null, failure })
      .where('id', '=', execution.id)
      .execute();
    await trx
      .updateTable('deliveries')
      .set({
        status: 'dead_lettered',
        completed_at: null,
        failed_at: null,
        dead_lettered_at: now,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
      } as any)
      .where('id', 'in', deliveryIds)
      .execute();
    return { disposition: 'dead_lettered' as const };
  }
}
