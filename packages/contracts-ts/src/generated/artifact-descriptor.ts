/** Generated from JSON Schema. Do not edit by hand. */

/**
 * This interface was referenced by `ArtifactDescriptor`'s JSON-Schema
 * via the `definition` "sha256Digest".
 */
export type Sha256Digest = string;
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
      digest: string;
    }
  | {
      kind: 'execution';
      executionId: string;
      attemptId: string;
    };

export interface ArtifactDescriptor {
  artifactId: string;
  digest: Sha256Digest;
  sizeBytes: number;
  mediaType: string;
  schemaId: string;
  schemaDigest: Sha256Digest;
  uri: string;
  provenance: SourceIdentity;
}
