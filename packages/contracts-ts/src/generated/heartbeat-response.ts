/** Generated from JSON Schema. Do not edit by hand. */

export interface WorkerHeartbeatResponse {
  protocolVersion: '1.0';
  leaseValid: boolean;
  leaseExpiresAt: string;
  cancellation: 'continue' | 'cancellation_requested';
}
