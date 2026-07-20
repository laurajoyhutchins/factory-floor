/** Generated from JSON Schema. Do not edit by hand. */

/**
 * A stable machine-readable diagnostic emitted while validating or normalizing repository-task intent.
 */
export interface RepositoryTaskDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
}
