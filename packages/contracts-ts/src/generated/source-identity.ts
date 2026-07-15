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
      digest: string;
    }
  | {
      kind: 'execution';
      executionId: string;
      attemptId: string;
    };
