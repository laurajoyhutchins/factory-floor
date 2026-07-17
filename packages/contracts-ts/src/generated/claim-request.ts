/** Generated from JSON Schema. Do not edit by hand. */

export type WorkerClaimRequest = (
  | {
      componentSelectors: unknown;
      [k: string]: unknown;
    }
  | {
      capabilities: unknown;
      [k: string]: unknown;
    }
) & {
  protocolVersion: '1.0';
  workerId: string;
  /**
   * @maxItems 64
   */
  componentSelectors?: string[];
  /**
   * Deprecated v1 compatibility name for componentSelectors.
   *
   * @maxItems 64
   */
  capabilities?: string[];
};
