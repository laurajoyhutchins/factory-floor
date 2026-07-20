/** Generated from JSON Schema. Do not edit by hand. */

/**
 * One immutable output promised by a normalized repository-task plan. Outputs describe required evidence or proposed repository content; they do not grant write authority.
 */
export interface RepositoryTaskDeclaredOutput {
  name: string;
  kind: 'file' | 'test' | 'export' | 'evidence';
  path: string;
  mediaType: string;
  required: boolean;
}
