import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const schemaDirectory = resolve(root, 'contracts/schemas');
const schemaNames = [
  'repository-task-declared-output.schema.json',
  'repository-task-recipe-invocation.schema.json',
  'repository-task-diagnostic.schema.json',
  'repository-task-authored-plan.schema.json',
  'repository-task-normalized-plan.schema.json',
];
const schemas = schemaNames.map((name) =>
  JSON.parse(readFileSync(resolve(schemaDirectory, name), 'utf8')),
);
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const schema of schemas) ajv.addSchema(schema);

const validateAuthoredPlan = ajv.getSchema(
  'https://factory-floor.local/contracts/repository-task-authored-plan.schema.json',
);
const validateNormalizedPlan = ajv.getSchema(
  'https://factory-floor.local/contracts/repository-task-normalized-plan.schema.json',
);
if (!validateAuthoredPlan || !validateNormalizedPlan)
  throw new Error('Failed to compile repository-task plan schemas');

export const DEFAULT_ALLOWED_REPOSITORY_TASK_CAPABILITIES = Object.freeze([
  'repository.proposePatch',
  'repository.read',
  'verification.request',
]);

export const DEFAULT_SUPPORTED_REPOSITORY_TASK_RECIPES = Object.freeze({
  'typescript-module': Object.freeze(['1']),
});

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pointerSegment(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function diagnostic(code, path, message) {
  return { code, severity: 'error', path, message };
}

function schemaDiagnostics(errors = []) {
  return errors.map((error) => {
    if (error.keyword === 'additionalProperties') {
      const property = error.params.additionalProperty;
      const path = `${error.instancePath}/${pointerSegment(property)}`;
      return diagnostic(
        'schema.unknown-field',
        path,
        `Unknown field ${property}.`,
      );
    }
    return diagnostic(
      'schema.invalid',
      error.instancePath,
      `${error.instancePath || '/'} ${error.message ?? 'is invalid'}.`,
    );
  });
}

function sortDiagnostics(diagnostics) {
  return [...diagnostics].sort((left, right) =>
    compareStrings(
      [left.code, left.path, left.message].join('\0'),
      [right.code, right.path, right.message].join('\0'),
    ),
  );
}

function collapseWhitespace(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function sortUnique(values, normalize = (value) => value.trim()) {
  return [...new Set(values.map(normalize))].sort(compareStrings);
}

export function canonicalizeRepositoryTaskValue(value) {
  if (Array.isArray(value))
    return value.map((item) => canonicalizeRepositoryTaskValue(item));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareStrings)
        .map((key) => [key, canonicalizeRepositoryTaskValue(value[key])]),
    );
  return value;
}

export function canonicalRepositoryTaskJson(value) {
  return JSON.stringify(canonicalizeRepositoryTaskValue(value));
}

export function computeRepositoryTaskPlanDigest(planWithoutDigest) {
  return createHash('sha256')
    .update(canonicalRepositoryTaskJson(planWithoutDigest), 'utf8')
    .digest('hex');
}

function isUnsafeRepositoryPath(value) {
  const path = value.trim();
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    /^[A-Za-z]:/.test(path)
  )
    return true;
  const segments = path.split('/');
  return segments.includes('..') || segments.includes('.git');
}

function hasUnsupportedAllowedPathPattern(value) {
  const path = value.trim();
  const withoutTerminalRecursiveGlob = path.endsWith('/**')
    ? path.slice(0, -3)
    : path;
  return /[*?[\]]/.test(withoutTerminalRecursiveGlob);
}

function hasOutputGlob(value) {
  return /[*?[\]]/.test(value);
}

function pathMatchesConstraint(path, constraint) {
  if (constraint.endsWith('/**')) {
    const prefix = constraint.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === constraint;
}

function semanticDiagnostics(plan, options) {
  const diagnostics = [];
  const allowedPaths = plan.allowedPaths.map((path) => path.trim());

  for (const [index, path] of plan.allowedPaths.entries()) {
    if (isUnsafeRepositoryPath(path))
      diagnostics.push(
        diagnostic(
          'path.unsafe',
          `/allowedPaths/${index}`,
          `Repository path ${JSON.stringify(path)} is not a safe relative path.`,
        ),
      );
    else if (hasUnsupportedAllowedPathPattern(path))
      diagnostics.push(
        diagnostic(
          'path.unsupported-pattern',
          `/allowedPaths/${index}`,
          'Allowed paths may be exact paths or end with a recursive /** glob.',
        ),
      );
  }

  for (const [index, output] of plan.outputContract.outputs.entries()) {
    if (isUnsafeRepositoryPath(output.path) || hasOutputGlob(output.path))
      diagnostics.push(
        diagnostic(
          'path.unsafe',
          `/outputContract/outputs/${index}/path`,
          `Output path ${JSON.stringify(output.path)} must be a concrete safe relative path.`,
        ),
      );
    else if (
      !allowedPaths.some((constraint) =>
        pathMatchesConstraint(output.path.trim(), constraint),
      )
    )
      diagnostics.push(
        diagnostic(
          'output.outside-allowed-paths',
          `/outputContract/outputs/${index}/path`,
          `Output path ${output.path} is outside the authored allowed path set.`,
        ),
      );
  }

  const duplicateOutputNames = new Set();
  const seenOutputNames = new Set();
  for (const output of plan.outputContract.outputs) {
    if (seenOutputNames.has(output.name)) duplicateOutputNames.add(output.name);
    seenOutputNames.add(output.name);
  }
  for (const name of [...duplicateOutputNames].sort(compareStrings))
    diagnostics.push(
      diagnostic(
        'output.duplicate-name',
        '/outputContract/outputs',
        `Output name ${name} is declared more than once.`,
      ),
    );

  const fileOutputCount = plan.outputContract.outputs.filter((output) =>
    ['file', 'test', 'export'].includes(output.kind),
  ).length;
  if (fileOutputCount > plan.resourceBounds.maxFiles)
    diagnostics.push(
      diagnostic(
        'resource.max-files-exceeded',
        '/resourceBounds/maxFiles',
        `The plan declares ${fileOutputCount} file outputs but maxFiles is ${plan.resourceBounds.maxFiles}.`,
      ),
    );

  const supportedVersions = options.supportedRecipes[plan.recipe.name] ?? [];
  if (!supportedVersions.includes(plan.recipe.version))
    diagnostics.push(
      diagnostic(
        'recipe.unsupported-version',
        '/recipe/version',
        `Recipe ${plan.recipe.name}@${plan.recipe.version} is not supported.`,
      ),
    );

  const allowedCapabilities = new Set(options.allowedCapabilities);
  for (const [index, capability] of plan.requestedCapabilities.entries())
    if (!allowedCapabilities.has(capability))
      diagnostics.push(
        diagnostic(
          'capability.not-allowed',
          `/requestedCapabilities/${index}`,
          `Capability ${capability} is outside the repository-task policy boundary.`,
        ),
      );

  return diagnostics;
}

function normalizeOutput(output) {
  return {
    name: output.name.trim(),
    kind: output.kind,
    path: output.path.trim(),
    mediaType: output.mediaType.trim().toLowerCase(),
    required: output.required,
  };
}

function normalizePlan(plan) {
  const planWithoutDigest = {
    schemaVersion: 1,
    objective: collapseWhitespace(plan.objective),
    repository: {
      owner: plan.repository.owner.trim(),
      name: plan.repository.name.trim(),
      baseRevision: plan.repository.baseRevision,
    },
    allowedPaths: sortUnique(plan.allowedPaths),
    recipe: {
      name: plan.recipe.name.trim(),
      version: plan.recipe.version.trim(),
      inputs: canonicalizeRepositoryTaskValue(plan.recipe.inputs),
    },
    outputs: plan.outputContract.outputs
      .map(normalizeOutput)
      .sort((left, right) =>
        compareStrings(
          [left.name, left.kind, left.path].join('\0'),
          [right.name, right.kind, right.path].join('\0'),
        ),
      ),
    verificationProfile: plan.verificationProfile.trim(),
    resourceBounds: {
      maxFiles: plan.resourceBounds.maxFiles,
      maxPatchBytes: plan.resourceBounds.maxPatchBytes,
      maxVerificationSeconds: plan.resourceBounds.maxVerificationSeconds,
    },
    requestedCapabilities: sortUnique(plan.requestedCapabilities),
    completionCriteria: sortUnique(
      plan.completionCriteria,
      collapseWhitespace,
    ),
  };
  return {
    ...planWithoutDigest,
    planDigest: computeRepositoryTaskPlanDigest(planWithoutDigest),
  };
}

export function normalizeRepositoryTaskPlan(authoredPlan, options = {}) {
  const resolvedOptions = {
    allowedCapabilities:
      options.allowedCapabilities ??
      DEFAULT_ALLOWED_REPOSITORY_TASK_CAPABILITIES,
    supportedRecipes:
      options.supportedRecipes ?? DEFAULT_SUPPORTED_REPOSITORY_TASK_RECIPES,
  };

  if (!validateAuthoredPlan(authoredPlan))
    return {
      normalizedPlan: null,
      diagnostics: sortDiagnostics(schemaDiagnostics(validateAuthoredPlan.errors)),
    };

  const diagnostics = semanticDiagnostics(authoredPlan, resolvedOptions);
  if (diagnostics.length > 0)
    return { normalizedPlan: null, diagnostics: sortDiagnostics(diagnostics) };

  const normalizedPlan = normalizePlan(authoredPlan);
  if (!validateNormalizedPlan(normalizedPlan))
    return {
      normalizedPlan: null,
      diagnostics: sortDiagnostics(
        (validateNormalizedPlan.errors ?? []).map((error) =>
          diagnostic(
            'normalized.schema-invalid',
            error.instancePath,
            `${error.instancePath || '/'} ${error.message ?? 'is invalid'}.`,
          ),
        ),
      ),
    };

  return { normalizedPlan, diagnostics: [] };
}
