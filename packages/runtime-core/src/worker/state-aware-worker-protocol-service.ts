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

export class WorkerProtocolService extends BaseWorkerProtocolService {
  constructor(
    private readonly stateDb: Kysely<Database>,
    blobStore: ArtifactBlobStore | undefined,
    options: WorkerProtocolOptions,
    clock = () => new Date(),
    private readonly componentStates = new ComponentStateRepository(),
  ) {
    super(stateDb, blobStore, options, clock);
  }

  override async buildEnvelope(
    scheduled: Parameters<BaseWorkerProtocolService['buildEnvelope']>[0],
  ) {
    const envelope = await super.buildEnvelope(scheduled);
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
