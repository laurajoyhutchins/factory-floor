/** Generated from JSON Schema. Do not edit by hand. */

/**
 * This interface was referenced by `RepositoryTaskRecipeInvocation`'s JSON-Schema
 * via the `definition` "recipeValue".
 */
export type RecipeValue =
  | RecipeLeaf
  | {
      [k: string]: RecipeLeaf;
    };
/**
 * This interface was referenced by `RepositoryTaskRecipeInvocation`'s JSON-Schema
 * via the `definition` "recipeLeaf".
 */
export type RecipeLeaf = RecipeScalar | RecipeScalar[];
/**
 * This interface was referenced by `RepositoryTaskRecipeInvocation`'s JSON-Schema
 * via the `definition` "recipeScalar".
 */
export type RecipeScalar = string | number | boolean | null;

/**
 * A versioned deterministic recipe selection and its bounded typed inputs. Recipe resolution remains repository-owned.
 */
export interface RepositoryTaskRecipeInvocation {
  name: 'typescript-module';
  version: string;
  inputs: {
    package: string;
    moduleName: string;
    responsibility?: string;
    /**
     * @minItems 1
     * @maxItems 32
     */
    exports?: [
      {
        name: string;
        typeName: string;
        value: RecipeValue;
      },
      ...{
        name: string;
        typeName: string;
        value: RecipeValue;
      }[]
    ];
    /**
     * @minItems 1
     * @maxItems 64
     */
    testCases?: [
      {
        name: string;
        exportName: string;
        expected: RecipeValue;
      },
      ...{
        name: string;
        exportName: string;
        expected: RecipeValue;
      }[]
    ];
  };
}
