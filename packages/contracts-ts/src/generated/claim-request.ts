/** Generated from JSON Schema. Do not edit by hand. */

export interface WorkerClaimRequest {
  protocolVersion: '1.0';
  workerId: string;
  /**
   * @maxItems 64
   */
  capabilities: string[];
}
