/** Generated from JSON Schema. Do not edit by hand. */

/**
 * Canonical replayable state derived from authored repository-task intent. The digest covers this object without planDigest and does not represent a policy grant.
 */
export interface RepositoryTaskNormalizedPlan {
  schemaVersion: 1;
  objective: string;
  repository: Repository;
  /**
   * @minItems 1
   * @maxItems 100
   */
  allowedPaths: [string, ...string[]];
  recipe: RepositoryTaskRecipeInvocation;
  /**
   * @minItems 1
   * @maxItems 100
   */
  outputs: [RepositoryTaskDeclaredOutput, ...RepositoryTaskDeclaredOutput[]];
  verificationProfile: string;
  resourceBounds: ResourceBounds;
  /**
   * @maxItems 32
   */
  requestedCapabilities: string[];
  /**
   * @minItems 1
   * @maxItems 32
   */
  completionCriteria: [string, ...string[]];
  planDigest: string;
}
/**
 * This interface was referenced by `RepositoryTaskNormalizedPlan`'s JSON-Schema
 * via the `definition` "repository".
 */
export interface Repository {
  owner: string;
  name: string;
  baseRevision: string;
}
/**
 * A versioned deterministic recipe selection and its bounded typed inputs. Recipe resolution remains repository-owned.
 */
export interface RepositoryTaskRecipeInvocation {
  name: 'typescript-module';
  version: string;
  inputs: {
    package: string;
    moduleName: string;
  };
}
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
/**
 * This interface was referenced by `RepositoryTaskNormalizedPlan`'s JSON-Schema
 * via the `definition` "resourceBounds".
 */
export interface ResourceBounds {
  maxFiles: number;
  maxPatchBytes: number;
  maxVerificationSeconds: number;
}
