import type { Kysely } from 'kysely';
import {
  ComponentStateRepository,
  type Database,
} from '@factory-floor/db';
import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import {
  WorkerProtocolService as BaseWorkerProtocolService,
  type WorkerProtocolOptions,
} from './worker-protocol-service.js';

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

  async claim(input: Parameters<BaseWorkerProtocolService['claim']>[0]) {
    const result = await this.base.claim(input);
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

  assertActive(...args: Parameters<BaseWorkerProtocolService['assertActive']>) {
    return this.base.assertActive(...args);
  }

  heartbeat(...args: Parameters<BaseWorkerProtocolService['heartbeat']>) {
    return this.base.heartbeat(...args);
  }

  cancellation(...args: Parameters<BaseWorkerProtocolService['cancellation']>) {
    return this.base.cancellation(...args);
  }

  stage(...args: Parameters<BaseWorkerProtocolService['stage']>) {
    return this.base.stage(...args);
  }

  upload(...args: Parameters<BaseWorkerProtocolService['upload']>) {
    return this.base.upload(...args);
  }

  submitResult(...args: Parameters<BaseWorkerProtocolService['submitResult']>) {
    return this.base.submitResult(...args);
  }

  invokeCapability(
    ...args: Parameters<BaseWorkerProtocolService['invokeCapability']>
  ) {
    return this.base.invokeCapability(...args);
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
