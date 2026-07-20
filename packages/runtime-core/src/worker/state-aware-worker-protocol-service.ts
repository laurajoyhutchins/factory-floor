import type { Readable } from 'node:stream';
import type { Kysely } from 'kysely';
import {
  ComponentStateRepository,
  type Database,
  type Json,
} from '@factory-floor/db';
import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import {
  WorkerProtocolService as BaseWorkerProtocolService,
  type WorkerProtocolOptions,
} from './worker-protocol-service.js';

export interface WorkerClaimInput {
  workerId: string;
  componentSelectors?: string[];
  capabilities?: string[];
}

export interface WorkerAttemptIdentityInput {
  executionId: string;
  attemptId: string;
  leaseToken: string;
  regionFencingEpoch?: number;
  lifecycleEpoch?: number;
}

export interface WorkerStageInput extends WorkerAttemptIdentityInput {
  portName: string;
  mediaType: string;
  expectedDigest: string;
  expectedSizeBytes: number;
  metadata: Json;
}

export interface WorkerStagedArtifactInput {
  stagingRef?: string;
  stagingId?: string;
  portName: string;
  digest: string;
  sizeBytes: number;
  mediaType: string;
  schemaId: string;
  schemaDigest: string;
}

export interface WorkerProposedResultInput extends WorkerAttemptIdentityInput {
  protocolVersion: '1.0';
  status: 'completed' | 'failed' | 'cancelled';
  stagedArtifacts: WorkerStagedArtifactInput[];
  proposedState?: WorkerStagedArtifactInput;
  proposedEvents: unknown[];
  externalActionProposals: unknown[];
  resourceUsage: unknown;
  failure?: unknown;
}

export interface WorkerCapabilityInput extends WorkerAttemptIdentityInput {
  handle: string;
  input: Json;
}

export class WorkerProtocolService {
  private readonly base: BaseWorkerProtocolService;

  constructor(
    private readonly stateDb: Kysely<Database>,
    blobStore: ArtifactBlobStore | undefined,
    options: WorkerProtocolOptions,
    clock = () => new Date(),
    private readonly componentStates = new ComponentStateRepository(),
  ) {
    this.base = new BaseWorkerProtocolService(
      stateDb,
      blobStore,
      options,
      clock,
    );
  }

  async claim(input: WorkerClaimInput) {
    const result = await this.base.claim(
      input as Parameters<BaseWorkerProtocolService['claim']>[0],
    );
    if (!result.claimed) return result;
    return {
      ...result,
      envelope: await this.withState(result.envelope),
    };
  }

  async buildEnvelope(
    scheduled: Parameters<BaseWorkerProtocolService['buildEnvelope']>[0],
  ) {
    return this.withState(await this.base.buildEnvelope(scheduled));
  }

  async assertActive(input: WorkerAttemptIdentityInput): Promise<void> {
    await this.base.assertActive(
      input as Parameters<BaseWorkerProtocolService['assertActive']>[0],
    );
  }

  heartbeat(input: WorkerAttemptIdentityInput) {
    return this.base.heartbeat(
      input as Parameters<BaseWorkerProtocolService['heartbeat']>[0],
    );
  }

  cancellation(input: WorkerAttemptIdentityInput) {
    return this.base.cancellation(
      input as Parameters<BaseWorkerProtocolService['cancellation']>[0],
    );
  }

  stage(input: WorkerStageInput) {
    return this.base.stage(
      input as Parameters<BaseWorkerProtocolService['stage']>[0],
    );
  }

  upload(
    stagedRef: string,
    input: WorkerAttemptIdentityInput,
    stream: Readable,
  ) {
    return this.base.upload(
      stagedRef,
      input as Parameters<BaseWorkerProtocolService['upload']>[1],
      stream,
    );
  }

  submitResult(input: WorkerProposedResultInput) {
    return this.base.submitResult(
      input as Parameters<BaseWorkerProtocolService['submitResult']>[0],
    );
  }

  invokeCapability(input: WorkerCapabilityInput) {
    return this.base.invokeCapability(
      input as Parameters<BaseWorkerProtocolService['invokeCapability']>[0],
    );
  }

  private async withState(
    envelope: Awaited<ReturnType<BaseWorkerProtocolService['buildEnvelope']>>,
  ) {
    const state = await this.componentStates.readLatestState(
      this.stateDb,
      envelope.component.componentId,
    );
    if (state === undefined) return envelope;

    return {
      ...envelope,
      state: {
        artifactId: state.artifact_id,
        digest: state.digest,
        sizeBytes: Number(state.size_bytes),
        mediaType: state.media_type,
        schemaId: state.schema_id,
        schemaDigest: state.schema_digest,
        uri: state.committed_locator ?? `inline-json://${state.digest}`,
        provenance: state.provenance,
      },
    };
  }
}
