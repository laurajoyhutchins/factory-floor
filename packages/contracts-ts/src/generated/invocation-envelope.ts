/** Generated from JSON Schema. Do not edit by hand. */

/**
 * Identity of the runtime object or actor that caused an invocation, proposal, or artifact.
 */
export type SourceIdentity =
  | {
      kind: 'command';
      commandId: string;
      submittedBy: string;
    }
  | {
      kind: 'event';
      eventId: string;
      producerComponentId: string;
    }
  | {
      kind: 'artifact';
      artifactId: string;
      /**
       * This interface was referenced by `ArtifactDescriptor`'s JSON-Schema
       * via the `definition` "sha256Digest".
       */
      digest: string;
    }
  | {
      kind: 'execution';
      executionId: string;
      attemptId: string;
    }
  | {
      kind: 'templateInstantiation';
      instantiationId: string;
      templateId: string;
      regionId: string;
    };

export interface InvocationEnvelope {
  protocolVersion: '1.0';
  executionId: string;
  attemptId: string;
  attemptNumber: number;
  leaseToken: string;
  leaseExpiresAt: string;
  lifecycleEpoch: number;
  component: {
    componentId: string;
    definitionId: string;
    definitionName: string;
    definitionVersion: string;
    definition: unknown;
    configuration: unknown;
  };
  inputs: {
    portName: string;
    deliveryId: string;
    payload: unknown;
    artifacts: ArtifactDescriptor[];
    artifactReadUrls: string[];
  }[];
  state: ArtifactDescriptor | null;
  capabilityHandles: string[];
  cancellationUrl: string;
  heartbeatUrl: string;
  resultSubmissionUrl: string;
  artifactStagingUrl: string;
  capabilityInvocationUrl: string;
  traceContext: {
    [k: string]: string;
  };
  limits: {
    heartbeatIntervalMs: number;
    maxArtifactBytes: number;
  };
  source: SourceIdentity;
}
export interface ArtifactDescriptor {
  artifactId: string;
  /**
   * This interface was referenced by `ArtifactDescriptor`'s JSON-Schema
   * via the `definition` "sha256Digest".
   */
  digest: string;
  sizeBytes: number;
  mediaType: string;
  schemaId: string;
  /**
   * This interface was referenced by `ArtifactDescriptor`'s JSON-Schema
   * via the `definition` "sha256Digest".
   */
  schemaDigest: string;
  uri: string;
  provenance: SourceIdentity;
}
