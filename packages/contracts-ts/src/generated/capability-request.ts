/** Generated from JSON Schema. Do not edit by hand. */

export interface WorkerCapabilityRequest {
  protocolVersion: '1.0';
  executionId: string;
  attemptId: string;
  leaseToken: string;
  lifecycleEpoch: number;
  handle: string;
  input: {
    [k: string]: unknown;
  };
}
