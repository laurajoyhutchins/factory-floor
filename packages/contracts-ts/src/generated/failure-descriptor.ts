/** Generated from JSON Schema. Do not edit by hand. */

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
