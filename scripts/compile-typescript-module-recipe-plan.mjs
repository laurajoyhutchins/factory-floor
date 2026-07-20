import { createHash } from 'node:crypto';
import { canonicalJsonDigest } from '../packages/runtime-core/src/declarations/canonical-json.js';
import { compileRepositoryTaskPlan } from './compile-repository-task-plan.mjs';
import { resolveTypescriptModuleRecipe } from './resolve-typescript-module-recipe.mjs';

function diagnostic(code, path, message) {
  return { code, severity: 'error', path, message };
}

function contentDigest(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function enrichGenerationGraph(generationGraph, operations) {
  const operationById = new Map(
    operations.map((operation) => [operation.id, operation]),
  );
  const graphWithoutDigest = { ...generationGraph };
  delete graphWithoutDigest.graphDigest;
  const enrichedWithoutDigest = {
    ...graphWithoutDigest,
    nodes: graphWithoutDigest.nodes.map((node) => {
      const proposal = operationById.get(node.id);
      if (!proposal) return node;
      const enriched = {
        ...node,
        content: proposal.content,
        contentDigest: proposal.contentDigest,
      };
      if (proposal.expectedDigest !== undefined)
        enriched.expectedDigest = proposal.expectedDigest;
      return enriched;
    }),
  };
  return {
    ...enrichedWithoutDigest,
    graphDigest: canonicalJsonDigest(enrichedWithoutDigest),
  };
}

export function compileTypescriptModuleRecipePlan(markdown, options = {}) {
  let resolution = null;
  const compiled = compileRepositoryTaskPlan(markdown, {
    profile: options.profile,
    recipeResolvers: {
      'typescript-module@1': (context) => {
        resolution = resolveTypescriptModuleRecipe({
          ...context,
          repositorySnapshot: options.repositorySnapshot,
        });
        return resolution;
      },
    },
  });

  if (resolution?.diagnostics.length > 0)
    return { generationGraph: null, diagnostics: resolution.diagnostics };
  if (!compiled.generationGraph || !resolution) return compiled;

  for (const operation of resolution.operations) {
    if (
      typeof operation.content === 'string' &&
      contentDigest(operation.content) === operation.contentDigest
    )
      continue;
    return {
      generationGraph: null,
      diagnostics: [
        diagnostic(
          'recipe.content-digest-mismatch',
          `/operations/${operation.id}`,
          `Operation ${operation.id} content digest is invalid.`,
        ),
      ],
    };
  }

  return {
    generationGraph: enrichGenerationGraph(
      compiled.generationGraph,
      resolution.operations,
    ),
    diagnostics: compiled.diagnostics,
  };
}
