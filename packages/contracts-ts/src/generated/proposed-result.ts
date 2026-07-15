/** Generated from JSON Schema. Do not edit by hand. */

export type ProposedResult =
  | {
      protocolVersion: '1.0';
      executionId: string;
      attemptId: string;
      leaseToken: string;
      lifecycleEpoch: number;
      stagedArtifacts: StagedArtifact[];
      proposedEvents: ProposedEvent[];
      proposedState?: StagedArtifact;
      externalActionProposals: ExternalActionProposal[];
      resourceUsage: ResourceUsage;
      status: 'completed';
    }
  | {
      protocolVersion: '1.0';
      executionId: string;
      attemptId: string;
      leaseToken: string;
      lifecycleEpoch: number;
      stagedArtifacts: StagedArtifact[];
      proposedEvents: ProposedEvent[];
      proposedState?: StagedArtifact;
      externalActionProposals: ExternalActionProposal[];
      resourceUsage: ResourceUsage;
      status: 'failed';
      failure: FailureDescriptor;
    }
  | {
      protocolVersion: '1.0';
      executionId: string;
      attemptId: string;
      leaseToken: string;
      lifecycleEpoch: number;
      stagedArtifacts: StagedArtifact[];
      proposedEvents: ProposedEvent[];
      proposedState?: StagedArtifact;
      externalActionProposals: ExternalActionProposal[];
      resourceUsage: ResourceUsage;
      status: 'cancelled';
    };
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

export interface StagedArtifact {
  stagingId: string;
  portName: string;
  digest: string;
  sizeBytes: number;
  mediaType: string;
  schemaId: string;
  schemaDigest: string;
  provenance: SourceIdentity;
}
export interface ProposedEvent {
  eventType: string;
  subject: string;
  payload: unknown;
  schemaId: string;
  schemaDigest: string;
  occurredAt: string;
  source: SourceIdentity;
}
export interface ExternalActionProposal {
  proposalId: string;
  actionType: string;
  idempotencyKey: string;
  capabilityHandle: string;
  requestArtifact: StagedArtifact;
  risk: 'low' | 'medium' | 'high' | 'irreversible';
}
export interface ResourceUsage {
  cpuMilliseconds: number;
  wallMilliseconds: number;
  inputBytes: number;
  outputBytes: number;
  externalCalls: number;
}
export interface FailureDescriptor {
  code: string;
  message: string;
  category:
    | 'invalid_input'
    | 'schema_mismatch'
    | 'capability_denied'
    | 'policy_denied'
    | 'timeout'
    | 'dependency'
    | 'model'
    | 'cancelled'
    | 'unknown';
  retryable: boolean;
  details?: {
    [k: string]: unknown;
  };
}
