import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Kysely } from 'kysely';
import {
  createUuidV7,
  type Database,
  type Json,
  type RuntimeDb,
} from '@factory-floor/db';
import {
  ArtifactBlobStoreError,
  type ArtifactBlobStore,
} from '@factory-floor/artifact-store';
import { canonicalJsonDigest } from '../declarations/canonical-json.js';
import { SchedulerService } from '../scheduling/scheduler-service.js';
import { ExecutionCommitError, ExecutionCommitService } from '../commit/execution-commit-service.js';

export type WorkerErrorCode =
  | 'invalid_request'
  | 'no_work'
  | 'inactive_attempt'
  | 'lease_expired'
  | 'stale_lease_token'
  | 'stale_lifecycle_epoch'
  | 'cancellation_requested'
  | 'unauthorized_staging_reference'
  | 'capability_denied'
  | 'duplicate_conflicting_result'
  | 'unsupported_protocol_version'
  | 'internal_transient_failure';

export class WorkerProtocolError extends Error {
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
    readonly retryable = false,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'WorkerProtocolError';
  }
}

export interface WorkerProtocolOptions {
  leaseDurationMs: number;
  baseUrl?: string;
}

interface AttemptIdentity {
  executionId: string;
  attemptId: string;
  leaseToken: string;
  lifecycleEpoch: number;
}

interface ClaimInput {
  workerId: string;
  capabilities: string[];
}

interface StageInput extends AttemptIdentity {
  portName: string;
  mediaType: string;
  expectedDigest: string;
  expectedSizeBytes: number;
  metadata: Json;
}

interface StagedArtifactInput {
  stagingId: string;
  portName: string;
  digest: string;
  sizeBytes: number;
  mediaType: string;
  schemaId: string;
  schemaDigest: string;
}

interface ProposedResultInput extends AttemptIdentity {
  protocolVersion: '1.0';
  status: 'completed' | 'failed' | 'cancelled';
  stagedArtifacts: StagedArtifactInput[];
  proposedState?: StagedArtifactInput;
  proposedEvents: unknown[];
  externalActionProposals: unknown[];
  resourceUsage: unknown;
  failure?: unknown;
}

interface ActiveAttemptRow {
  attempt_status: string;
  lease_token: string | null;
  lease_expires_at: Date | null;
  execution_lifecycle_epoch: number;
  region_lifecycle_epoch: number;
  lifecycle_status: string;
  component_instance_id: string;
}

export class WorkerProtocolService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly blobStore: ArtifactBlobStore | undefined,
    private readonly options: WorkerProtocolOptions,
    private readonly clock = () => new Date(),
  ) {}

  async claim(input: ClaimInput) {
    const scheduled = await new SchedulerService(this.db, this.clock).pollForExecution({
      owner: input.workerId,
      leaseDurationMs: this.options.leaseDurationMs,
      capabilities: input.capabilities,
    });
    if (!scheduled)
      return { protocolVersion: '1.0' as const, claimed: false as const, retryAfterMs: 250 };
    return {
      protocolVersion: '1.0' as const,
      claimed: true as const,
      envelope: await this.buildEnvelope(scheduled),
    };
  }

  private url(path: string, query?: Record<string, string | number>) {
    const url = new URL(path, this.options.baseUrl ?? 'http://127.0.0.1');
    for (const [key, value] of Object.entries(query ?? {}))
      url.searchParams.set(key, String(value));
    return url.toString();
  }

  async buildEnvelope(scheduled: {
    executionId: string;
    attemptId: string;
    attemptNumber: number;
    leaseToken: string;
    leaseExpiresAt: string;
    inputs: { portName: string; deliveryId: string; payload: unknown }[];
  }) {
    const row = await this.db
      .selectFrom('executions as e')
      .innerJoin('regions as r', 'r.id', 'e.region_id')
      .innerJoin('component_instances as c', 'c.id', 'e.component_instance_id')
      .innerJoin(
        'component_definitions as d',
        'd.id',
        'c.component_definition_id',
      )
      .select([
        'e.lifecycle_epoch',
        'c.id as component_id',
        'c.configuration',
        'd.id as definition_id',
        'd.name as definition_name',
        'd.version as definition_version',
        'd.definition',
      ])
      .where('e.id', '=', scheduled.executionId)
      .executeTakeFirstOrThrow();
    return {
      protocolVersion: '1.0' as const,
      executionId: scheduled.executionId,
      attemptId: scheduled.attemptId,
      attemptNumber: scheduled.attemptNumber,
      leaseToken: scheduled.leaseToken,
      leaseExpiresAt: scheduled.leaseExpiresAt,
      lifecycleEpoch: row.lifecycle_epoch,
      component: {
        componentId: row.component_id,
        definitionId: row.definition_id,
        definitionName: row.definition_name,
        definitionVersion: row.definition_version,
        configuration: row.configuration,
        definition: row.definition,
      },
      inputs: scheduled.inputs.map((input) => ({
        portName: input.portName,
        deliveryId: input.deliveryId,
        payload: input.payload,
        artifacts: [],
        artifactReadUrls: [],
      })),
      state: null,
      capabilityHandles: [],
      heartbeatUrl: this.url('/worker/v1/heartbeat'),
      cancellationUrl: this.url('/worker/v1/cancellation'),
      resultSubmissionUrl: this.url('/worker/v1/results'),
      artifactStagingUrl: this.url('/worker/v1/artifacts/stage'),
      capabilityInvocationUrl: this.url('/worker/v1/capabilities/invoke'),
      traceContext: {
        traceparent: `00-${createHash('sha256')
          .update(scheduled.attemptId)
          .digest('hex')
          .slice(0, 32)}-${createHash('sha256')
          .update(scheduled.executionId)
          .digest('hex')
          .slice(0, 16)}-01`,
      },
      limits: {
        heartbeatIntervalMs: Math.floor(this.options.leaseDurationMs / 3),
        maxArtifactBytes: 104_857_600,
      },
      source: {
        kind: 'execution' as const,
        executionId: scheduled.executionId,
        attemptId: scheduled.attemptId,
      },
    };
  }

  private async activeAttempt(
    input: AttemptIdentity,
    db: RuntimeDb = this.db,
    lock = false,
  ): Promise<ActiveAttemptRow> {
    const baseQuery = db
      .selectFrom('execution_attempts as a')
      .innerJoin('executions as e', 'e.id', 'a.execution_id')
      .innerJoin('regions as r', 'r.id', 'e.region_id')
      .select([
        'a.status as attempt_status',
        'a.lease_token',
        'a.lease_expires_at',
        'e.lifecycle_epoch as execution_lifecycle_epoch',
        'r.lifecycle_epoch as region_lifecycle_epoch',
        'r.lifecycle_status',
        'e.component_instance_id',
      ])
      .where('a.id', '=', input.attemptId)
      .where('a.execution_id', '=', input.executionId);
    const row = await (lock ? baseQuery.forUpdate() : baseQuery).executeTakeFirst();
    if (!row || !['leased', 'running'].includes(row.attempt_status))
      throw new WorkerProtocolError(
        'inactive_attempt',
        'attempt is not active',
        false,
        409,
      );
    if (row.lease_token !== input.leaseToken)
      throw new WorkerProtocolError(
        'stale_lease_token',
        'lease token is not current',
        false,
        409,
      );
    if (
      row.execution_lifecycle_epoch !== input.lifecycleEpoch ||
      row.region_lifecycle_epoch !== input.lifecycleEpoch
    )
      throw new WorkerProtocolError(
        'stale_lifecycle_epoch',
        'lifecycle epoch is not current',
        false,
        409,
      );
    if (!row.lease_expires_at || row.lease_expires_at <= this.clock())
      throw new WorkerProtocolError(
        'lease_expired',
        'lease has expired',
        true,
        409,
      );
    return row;
  }

  async assertActive(input: AttemptIdentity) {
    return this.activeAttempt(input);
  }

  async heartbeat(input: AttemptIdentity) {
    return this.db.transaction().execute(async (transaction) => {
      const row = await this.activeAttempt(input, transaction, true);
      const leaseExpiresAt = new Date(
        this.clock().getTime() + this.options.leaseDurationMs,
      );
      await transaction
        .updateTable('execution_attempts')
        .set({ status: 'running', lease_expires_at: leaseExpiresAt })
        .where('id', '=', input.attemptId)
        .where('execution_id', '=', input.executionId)
        .where('lease_token', '=', input.leaseToken)
        .executeTakeFirstOrThrow();
      return {
        protocolVersion: '1.0' as const,
        leaseValid: true,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        cancellation:
          row.lifecycle_status === 'cancelling' ||
          row.lifecycle_status === 'cancelled'
            ? ('cancellation_requested' as const)
            : ('continue' as const),
      };
    });
  }

  async cancellation(input: AttemptIdentity) {
    const row = await this.db
      .selectFrom('execution_attempts as a')
      .innerJoin('executions as e', 'e.id', 'a.execution_id')
      .innerJoin('regions as r', 'r.id', 'e.region_id')
      .select([
        'a.status as attempt_status',
        'a.lease_token',
        'a.lease_expires_at',
        'e.lifecycle_epoch as execution_lifecycle_epoch',
        'r.lifecycle_epoch as region_lifecycle_epoch',
        'r.lifecycle_status',
      ])
      .where('a.id', '=', input.attemptId)
      .where('a.execution_id', '=', input.executionId)
      .executeTakeFirst();
    if (!row || !['leased', 'running'].includes(row.attempt_status))
      return { protocolVersion: '1.0' as const, state: 'attempt_terminal' as const };
    if (
      row.lease_token !== input.leaseToken ||
      !row.lease_expires_at ||
      row.lease_expires_at <= this.clock() ||
      row.execution_lifecycle_epoch !== input.lifecycleEpoch
    )
      return {
        protocolVersion: '1.0' as const,
        state: 'lease_no_longer_valid' as const,
      };
    if (
      row.region_lifecycle_epoch !== input.lifecycleEpoch ||
      row.lifecycle_status === 'cancelling' ||
      row.lifecycle_status === 'cancelled'
    )
      return {
        protocolVersion: '1.0' as const,
        state: 'cancellation_requested' as const,
      };
    return { protocolVersion: '1.0' as const, state: 'continue' as const };
  }

  async stage(input: StageInput) {
    return this.db.transaction().execute(async (transaction) => {
      const active = await this.activeAttempt(input, transaction, true);
      const port = await transaction
        .selectFrom('port_definitions as p')
        .innerJoin(
          'component_instances as c',
          'c.component_definition_id',
          'p.component_definition_id',
        )
        .select(['p.schema_id'])
        .where('c.id', '=', active.component_instance_id)
        .where('p.direction', '=', 'output')
        .where('p.name', '=', input.portName)
        .executeTakeFirst();
      if (!port)
        throw new WorkerProtocolError(
          'unauthorized_staging_reference',
          'output port is not declared',
          false,
          403,
        );
      const stagedRef = createUuidV7();
      const policyExpiration = new Date(
        this.clock().getTime() + this.options.leaseDurationMs,
      );
      const expiresAt = new Date(
        Math.min(active.lease_expires_at!.getTime(), policyExpiration.getTime()),
      );
      await transaction
        .insertInto('worker_artifact_uploads')
        .values({
          id: createUuidV7(),
          staged_ref: stagedRef,
          execution_id: input.executionId,
          attempt_id: input.attemptId,
          lifecycle_epoch: input.lifecycleEpoch,
          port_name: input.portName,
          schema_id: port.schema_id,
          media_type: input.mediaType,
          expected_digest: input.expectedDigest,
          expected_size_bytes: String(input.expectedSizeBytes),
          metadata: input.metadata,
          expires_at: expiresAt,
          uploaded_at: null,
          artifact_staging_id: null,
        })
        .execute();
      return {
        protocolVersion: '1.0' as const,
        stagedRef,
        uploadUrl: this.url(`/worker/v1/artifacts/upload/${stagedRef}`, {
          protocolVersion: '1.0',
          executionId: input.executionId,
          attemptId: input.attemptId,
          leaseToken: input.leaseToken,
          lifecycleEpoch: input.lifecycleEpoch,
        }),
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async upload(stagedRef: string, input: AttemptIdentity, stream: Readable) {
    if (!this.blobStore)
      throw new WorkerProtocolError(
        'internal_transient_failure',
        'artifact blob store is not configured',
        true,
        503,
      );
    await this.activeAttempt(input);
    const authorization = await this.db
      .selectFrom('worker_artifact_uploads')
      .selectAll()
      .where('staged_ref', '=', stagedRef)
      .where('execution_id', '=', input.executionId)
      .where('attempt_id', '=', input.attemptId)
      .where('lifecycle_epoch', '=', input.lifecycleEpoch)
      .executeTakeFirst();
    if (!authorization || authorization.expires_at <= this.clock())
      throw new WorkerProtocolError(
        'unauthorized_staging_reference',
        'staged artifact reference is not authorized for this attempt',
        false,
        403,
      );

    let receipt;
    try {
      receipt = await this.blobStore.stage(stagedRef, stream, {
        expectedDigest: authorization.expected_digest,
        expectedSize: BigInt(authorization.expected_size_bytes),
      });
    } catch (error) {
      if (error instanceof ArtifactBlobStoreError) {
        if (
          error.code === 'digest_mismatch' ||
          error.code === 'size_mismatch' ||
          error.code === 'invalid_digest' ||
          error.code === 'invalid_size'
        )
          throw new WorkerProtocolError('invalid_request', error.message, false, 400);
        if (error.code === 'staging_conflict')
          throw new WorkerProtocolError(
            'unauthorized_staging_reference',
            error.message,
            false,
            409,
          );
      }
      throw error;
    }

    await this.db.transaction().execute(async (transaction) => {
      await this.activeAttempt(input, transaction, true);
      const current = await transaction
        .selectFrom('worker_artifact_uploads')
        .selectAll()
        .where('staged_ref', '=', stagedRef)
        .forUpdate()
        .executeTakeFirst();
      if (
        !current ||
        current.execution_id !== input.executionId ||
        current.attempt_id !== input.attemptId ||
        current.lifecycle_epoch !== input.lifecycleEpoch ||
        current.expires_at <= this.clock()
      )
        throw new WorkerProtocolError(
          'unauthorized_staging_reference',
          'staged artifact reference is no longer authorized',
          false,
          403,
        );

      const stagingId = current.artifact_staging_id ?? createUuidV7();
      await transaction
        .insertInto('artifact_staging')
        .values({
          id: stagingId,
          attempt_id: input.attemptId,
          staged_ref: stagedRef,
          digest_algorithm: 'sha256',
          digest: receipt.digest,
          size_bytes: receipt.size.toString(),
          schema_id: current.schema_id,
          media_type: current.media_type,
          locator: receipt.stagedLocator,
          status: 'staged',
          metadata: current.metadata,
          artifact_id: null,
          promoted_at: null,
          abandoned_at: null,
        })
        .onConflict((conflict) =>
          conflict.columns(['attempt_id', 'staged_ref']).doNothing(),
        )
        .execute();
      const staged = await transaction
        .selectFrom('artifact_staging')
        .selectAll()
        .where('attempt_id', '=', input.attemptId)
        .where('staged_ref', '=', stagedRef)
        .executeTakeFirstOrThrow();
      if (
        staged.digest !== receipt.digest ||
        staged.size_bytes !== receipt.size.toString() ||
        staged.schema_id !== current.schema_id ||
        staged.media_type !== current.media_type ||
        staged.locator !== receipt.stagedLocator
      )
        throw new WorkerProtocolError(
          'unauthorized_staging_reference',
          'staged artifact metadata conflicts with an existing upload',
          false,
          409,
        );
      await transaction
        .updateTable('worker_artifact_uploads')
        .set({
          uploaded_at: this.clock(),
          artifact_staging_id: staged.id,
        })
        .where('id', '=', current.id)
        .execute();
    });

    return {
      protocolVersion: '1.0' as const,
      stagedRef,
      digest: receipt.digest,
      sizeBytes: Number(receipt.size),
    };
  }

  private async validateStagedArtifacts(
    db: RuntimeDb,
    attemptId: string,
    artifacts: StagedArtifactInput[],
  ) {
    for (const artifact of artifacts) {
      const row = await db
        .selectFrom('artifact_staging as s')
        .innerJoin('artifact_schemas as schema', 'schema.id', 's.schema_id')
        .select([
          's.staged_ref',
          's.digest',
          's.size_bytes',
          's.schema_id',
          's.media_type',
          's.status',
          'schema.content_digest as schema_digest',
        ])
        .where('s.attempt_id', '=', attemptId)
        .where('s.staged_ref', '=', artifact.stagingId)
        .executeTakeFirst();
      if (
        !row ||
        row.status !== 'staged' ||
        row.digest !== artifact.digest ||
        row.size_bytes !== String(artifact.sizeBytes) ||
        row.schema_id !== artifact.schemaId ||
        row.schema_digest !== artifact.schemaDigest ||
        row.media_type !== artifact.mediaType
      )
        throw new WorkerProtocolError(
          'unauthorized_staging_reference',
          'staged artifact reference does not match authorized content',
          false,
          403,
        );
    }
  }

  async submitResult(input: ProposedResultInput) {
    const digest = canonicalJsonDigest(input);
    const handoff = await this.db.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom('worker_result_submissions')
        .select('submission_digest')
        .where('attempt_id', '=', input.attemptId)
        .executeTakeFirst();
      if (existing) {
        if (existing.submission_digest === digest)
          return { duplicate: true as const };
        throw new WorkerProtocolError(
          'duplicate_conflicting_result',
          'attempt already has a different proposed result',
          false,
          409,
        );
      }
      await this.activeAttempt(input, transaction, true);
      await this.validateStagedArtifacts(transaction, input.attemptId, [
        ...input.stagedArtifacts,
        ...(input.proposedState ? [input.proposedState] : []),
      ]);
      await transaction
        .insertInto('worker_result_submissions')
        .values({
          id: createUuidV7(),
          execution_id: input.executionId,
          attempt_id: input.attemptId,
          submission_digest: digest,
          result: input as unknown as Json,
        })
        .execute();
      return { duplicate: false as const };
    });
    try {
      await new ExecutionCommitService(this.db, this.blobStore, this.clock).commit(input as Parameters<ExecutionCommitService['commit']>[0]);
    } catch (error) {
      if (error instanceof ExecutionCommitError)
        throw new WorkerProtocolError(
          error.code === 'external_action_unauthorized'
            ? 'capability_denied'
            : error.code === 'invalid_staged_artifact'
              ? 'unauthorized_staging_reference'
              : (error.code as WorkerErrorCode),
          error.message,
          error.statusCode >= 500,
          error.statusCode,
        );
      throw error;
    }
    return {
      protocolVersion: '1.0' as const,
      accepted: true,
      duplicate: handoff.duplicate,
      handoff: 'committed_by_control_plane' as const,
    };
  }

  async invokeCapability(input: AttemptIdentity & { handle: string; input: Json }) {
    await this.activeAttempt(input);
    throw new WorkerProtocolError(
      'capability_denied',
      'no capability handles are issued by the Task 7A protocol implementation',
      false,
      403,
    );
  }
}
