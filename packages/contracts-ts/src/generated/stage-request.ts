/** Generated from JSON Schema. Do not edit by hand. */

export interface WorkerStageRequest {
  protocolVersion: '1.0';
  executionId: string;
  attemptId: string;
  leaseToken: string;
  lifecycleEpoch: number;
  portName: string;
  mediaType: string;
  expectedDigest: string;
  expectedSizeBytes: number;
  metadata: {
    [k: string]: unknown;
  };
}
