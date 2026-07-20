/** Generated from JSON Schema. Do not edit by hand. */

/**
 * A versioned deterministic recipe selection and its bounded inputs. Recipe resolution remains repository-owned.
 */
export interface RepositoryTaskRecipeInvocation {
  name: string;
  version: string;
  inputs: {
    [k: string]: unknown;
  };
}
