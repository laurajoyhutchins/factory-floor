/** Generated from JSON Schema. Do not edit by hand. */

export interface WorkerError {
  protocolVersion: '1.0';
  code: string;
  message: string;
  retryable: boolean;
  requestId: string;
  details?: {
    [k: string]: unknown;
  };
}
