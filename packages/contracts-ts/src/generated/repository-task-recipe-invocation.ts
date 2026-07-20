/** Generated from JSON Schema. Do not edit by hand. */

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
