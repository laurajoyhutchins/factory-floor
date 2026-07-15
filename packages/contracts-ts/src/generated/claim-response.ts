/** Generated from JSON Schema. Do not edit by hand. */

export type WorkerClaimResponse =
  | {
      protocolVersion: '1.0';
      claimed: true;
      envelope: unknown;
    }
  | {
      protocolVersion: '1.0';
      claimed: false;
      retryAfterMs: number;
    };
