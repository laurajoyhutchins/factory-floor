/** Generated from JSON Schema. Do not edit by hand. */

export interface WorkerCancellationResponse {
  protocolVersion: '1.0';
  state: 'continue' | 'cancellation_requested' | 'lease_no_longer_valid' | 'attempt_terminal';
}
