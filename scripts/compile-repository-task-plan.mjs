import { parseDocument } from 'yaml';
import {
  canonicalizeJson,
  canonicalJsonDigest,
} from '../packages/runtime-core/src/declarations/canonical-json.js';
import { normalizeRepositoryTaskPlan } from './normalize-repository-task-plan.mjs';

const PLAN_NODE_ID = 'input:normalized-plan';
const PROFILE_NODE_ID = 'input:repository-profile';
const INPUT_NODE_IDS = new Set([PLAN_NODE_ID, PROFILE_NODE_ID]);
const PROFILE_KEYS = [
  'schemaVersion',
  'repository',
  'pathBoundaries',
  'recipes',
  'verificationProfiles',
  'packages',
];
const PACKAGE_KEYS = [
  'name',
  'path',
  'sourceDirectory',
  'testDirectory',
  'publicExportPath',
];

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic(code, path, message) {
  return { code, severity: 'error', path, message };
}

function sortDiagnostics(values) {
  return [...values].sort((left, right) =>
    compareStrings(
      [left.code, left.path, left.message].join('\0'),
      [right.code, right.path, right.message].join('\0'),
    ),
  );
}

function failure(code, path, message) {
  return {
    generationGraph: null,
    diagnostics: [diagnostic(code, path, message)],
  };
}

function isObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return JSON.parse(canonicalizeJson(value));
}

function sortedStrings(values) {
  return [...new Set(values.map((value) => value.trim()))].sort(compareStrings);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function safePath(value) {
  if (!nonEmptyString(value)) return false;
  const path = value.trim();
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    /^[A-Za-z]:/.test(path)
  )
    return false;
  return !path
    .split('/')
    .some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment === '.git',
    );
}

function pathConstraint(value) {
  if (!safePath(value)) return false;
  const base = value.endsWith('/**') ? value.slice(0, -3) : value;
  return !/[*?[\]]/.test(base);
}

function pathMatches(path, constraint) {
  if (!constraint.endsWith('/**')) return path === constraint;
  const prefix = constraint.slice(0, -3);
  return path === prefix || path.startsWith(`${prefix}/`);
}

function constraintFits(constraint, boundary) {
  const base = constraint.endsWith('/**')
    ? constraint.slice(0, -3)
    : constraint;
  return pathMatches(base, boundary);
}

function unknownKeyDiagnostics(value, allowed, path) {
  if (!isObject(value)) return [];
  const allowedKeys = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !allowedKeys.has(key))
    .map((key) =>
      diagnostic(
        'profile.unknown-field',
        `${path}/${key}`,
        `Unknown repository-profile field ${key}.`,
      ),
    );
}

function normalizeProfile(input) {
  const diagnostics = [];
  if (!isObject(input))
    return {
      profile: null,
      diagnostics: [
        diagnostic(
          'profile.invalid',
          '',
          'Repository profile must be an object.',
        ),
      ],
    };

  diagnostics.push(...unknownKeyDiagnostics(input, PROFILE_KEYS, ''));
  if (input.schemaVersion !== 1)
    diagnostics.push(
      diagnostic(
        'profile.invalid',
        '/schemaVersion',
        'Repository profile schemaVersion must be 1.',
      ),
    );

  if (
    !isObject(input.repository) ||
    !nonEmptyString(input.repository.owner) ||
    !nonEmptyString(input.repository.name)
  )
    diagnostics.push(
      diagnostic(
        'profile.invalid',
        '/repository',
        'Repository profile must declare owner and name.',
      ),
    );

  const boundaries = Array.isArray(input.pathBoundaries)
    ? input.pathBoundaries
    : [];
  if (
    boundaries.length === 0 ||
    boundaries.some((value) => !pathConstraint(value))
  )
    diagnostics.push(
      diagnostic(
        'profile.invalid-path-boundary',
        '/pathBoundaries',
        'Path boundaries must be safe relative paths or terminal recursive globs.',
      ),
    );

  if (!isObject(input.recipes) || Object.keys(input.recipes).length === 0)
    diagnostics.push(
      diagnostic(
        'profile.invalid',
        '/recipes',
        'Repository profile must declare supported recipe versions.',
      ),
    );
  else
    for (const [name, versions] of Object.entries(input.recipes)) {
      if (
        !nonEmptyString(name) ||
        !Array.isArray(versions) ||
        versions.length === 0 ||
        versions.some((version) => !nonEmptyString(version))
      )
        diagnostics.push(
          diagnostic(
            'profile.invalid',
            `/recipes/${name}`,
            'Recipe versions must be non-empty strings.',
          ),
        );
    }

  const verificationProfiles = Array.isArray(input.verificationProfiles)
    ? input.verificationProfiles
    : [];
  if (
    verificationProfiles.length === 0 ||
    verificationProfiles.some((value) => !nonEmptyString(value))
  )
    diagnostics.push(
      diagnostic(
        'profile.invalid',
        '/verificationProfiles',
        'Repository profile must declare verification profiles.',
      ),
    );

  const packages = Array.isArray(input.packages) ? input.packages : [];
  if (packages.length === 0)
    diagnostics.push(
      diagnostic(
        'profile.invalid',
        '/packages',
        'Repository profile must declare at least one package.',
      ),
    );
  for (const [index, packageEntry] of packages.entries()) {
    diagnostics.push(
      ...unknownKeyDiagnostics(
        packageEntry,
        PACKAGE_KEYS,
        `/packages/${index}`,
      ),
    );
    if (
      !isObject(packageEntry) ||
      PACKAGE_KEYS.some((key) => !nonEmptyString(packageEntry[key])) ||
      ['path', 'sourceDirectory', 'testDirectory', 'publicExportPath'].some(
        (key) =>
          nonEmptyString(packageEntry[key]) && !safePath(packageEntry[key]),
      )
    )
      diagnostics.push(
        diagnostic(
          'profile.invalid-package',
          `/packages/${index}`,
          'Package entries require a name and safe relative paths.',
        ),
      );
  }

  if (diagnostics.length > 0)
    return { profile: null, diagnostics: sortDiagnostics(diagnostics) };

  const recipes = {};
  for (const name of Object.keys(input.recipes).sort(compareStrings))
    recipes[name.trim()] = sortedStrings(input.recipes[name]);

  const profile = {
    schemaVersion: 1,
    repository: {
      owner: input.repository.owner.trim().toLowerCase(),
      name: input.repository.name.trim().toLowerCase(),
    },
    pathBoundaries: sortedStrings(boundaries),
    recipes,
    verificationProfiles: sortedStrings(verificationProfiles),
    packages: packages
      .map((packageEntry) => ({
        name: packageEntry.name.trim(),
        path: packageEntry.path.trim(),
        sourceDirectory: packageEntry.sourceDirectory.trim(),
        testDirectory: packageEntry.testDirectory.trim(),
        publicExportPath: packageEntry.publicExportPath.trim(),
      }))
      .sort((left, right) => compareStrings(left.name, right.name)),
  };

  const packageNames = new Set();
  for (const [index, packageEntry] of profile.packages.entries()) {
    if (packageNames.has(packageEntry.name))
      diagnostics.push(
        diagnostic(
          'profile.duplicate-package',
          '/packages',
          `Package ${packageEntry.name} is declared more than once.`,
        ),
      );
    packageNames.add(packageEntry.name);
    if (
      !profile.pathBoundaries.some((value) =>
        pathMatches(packageEntry.path, value),
      )
    )
      diagnostics.push(
        diagnostic(
          'profile.package-outside-boundaries',
          `/packages/${index}/path`,
          `Package path ${packageEntry.path} is outside profile boundaries.`,
        ),
      );
  }

  return diagnostics.length > 0
    ? { profile: null, diagnostics: sortDiagnostics(diagnostics) }
    : { profile, diagnostics: [] };
}

function checkPlanAgainstProfile(plan, profile) {
  const diagnostics = [];
  if (
    plan.repository.owner !== profile.repository.owner ||
    plan.repository.name !== profile.repository.name
  )
    diagnostics.push(
      diagnostic(
        'profile.repository-mismatch',
        '/repository',
        'Plan repository does not match the repository profile.',
      ),
    );
  for (const [index, value] of plan.allowedPaths.entries()) {
    if (
      !profile.pathBoundaries.some((boundary) =>
        constraintFits(value, boundary),
      )
    )
      diagnostics.push(
        diagnostic(
          'profile.path-outside-boundaries',
          `/allowedPaths/${index}`,
          `Allowed path ${value} is outside repository-profile boundaries.`,
        ),
      );
  }
  if (!profile.recipes[plan.recipe.name]?.includes(plan.recipe.version))
    diagnostics.push(
      diagnostic(
        'profile.recipe-unsupported',
        '/recipe',
        `Recipe ${plan.recipe.name}@${plan.recipe.version} is not supported by the repository profile.`,
      ),
    );
  if (!profile.verificationProfiles.includes(plan.verificationProfile))
    diagnostics.push(
      diagnostic(
        'profile.verification-profile-unsupported',
        '/verificationProfile',
        `Verification profile ${plan.verificationProfile} is not supported by the repository profile.`,
      ),
    );

  const packageName = plan.recipe.inputs.package;
  const selectedPackage = profile.packages.find(
    (packageEntry) => packageEntry.name === packageName,
  );
  if (!selectedPackage)
    diagnostics.push(
      diagnostic(
        'profile.package-unknown',
        '/recipe/inputs/package',
        `Package ${packageName} is not declared by the repository profile.`,
      ),
    );
  else
    for (const [index, output] of plan.outputs.entries()) {
      if (!pathMatches(output.path, `${selectedPackage.path}/**`))
        diagnostics.push(
          diagnostic(
            'profile.output-outside-package',
            `/outputs/${index}/path`,
            `Output ${output.path} is outside selected package ${packageName}.`,
          ),
        );
    }
  return sortDiagnostics(diagnostics);
}

function normalizeAttribution(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) =>
        !isObject(entry) ||
        !['plan', 'profile', 'recipe'].includes(entry.kind) ||
        !nonEmptyString(entry.reference),
    )
  )
    return null;
  return value
    .map((entry) => ({ kind: entry.kind, reference: entry.reference.trim() }))
    .sort((left, right) =>
      compareStrings(
        [left.kind, left.reference].join('\0'),
        [right.kind, right.reference].join('\0'),
      ),
    );
}

function normalizeResolution(resolution, plan, profile) {
  if (!isObject(resolution) || !Array.isArray(resolution.operations))
    return {
      operations: null,
      conflicts: null,
      diagnostics: [
        diagnostic(
          'recipe.invalid-resolution',
          '',
          'Recipe resolver must return an operations array.',
        ),
      ],
    };

  const diagnostics = [];
  const conflicts = Array.isArray(resolution.conflicts)
    ? clone(resolution.conflicts)
    : [];
  if (conflicts.length > 0)
    diagnostics.push(
      diagnostic(
        'graph.recipe-conflict',
        '/conflicts',
        'Recipe resolution reported one or more conflicts.',
      ),
    );

  const declaredOutputs = new Map(
    plan.outputs.map((output, index) => [output.name, { output, index }]),
  );
  const operations = [];
  for (const [index, candidate] of resolution.operations.entries()) {
    const pointer = `/operations/${index}`;
    const attribution = isObject(candidate)
      ? normalizeAttribution(candidate.attribution)
      : null;
    if (
      !isObject(candidate) ||
      !nonEmptyString(candidate.id) ||
      !['create', 'update', 'delete'].includes(candidate.operation) ||
      !safePath(candidate.path) ||
      !nonEmptyString(candidate.outputName) ||
      !nonEmptyString(candidate.mediaType) ||
      !Array.isArray(candidate.dependsOn) ||
      candidate.dependsOn.some((value) => !nonEmptyString(value)) ||
      attribution === null
    ) {
      diagnostics.push(
        diagnostic(
          'graph.invalid-operation',
          pointer,
          'Recipe emitted an invalid file operation.',
        ),
      );
      continue;
    }

    const operation = {
      id: candidate.id.trim(),
      kind: 'file-operation',
      operation: candidate.operation,
      path: candidate.path.trim(),
      outputName: candidate.outputName.trim(),
      mediaType: candidate.mediaType.trim().toLowerCase(),
      dependsOn: sortedStrings(candidate.dependsOn),
      attribution,
    };
    const declared = declaredOutputs.get(operation.outputName);
    if (!declared)
      diagnostics.push(
        diagnostic(
          'graph.undeclared-output',
          `${pointer}/outputName`,
          `Output ${operation.outputName} is not declared by the plan.`,
        ),
      );
    else if (
      declared.output.path !== operation.path ||
      declared.output.mediaType !== operation.mediaType
    )
      diagnostics.push(
        diagnostic(
          'graph.output-mismatch',
          pointer,
          `Operation ${operation.id} does not match its declared output.`,
        ),
      );
    if (!plan.allowedPaths.some((value) => pathMatches(operation.path, value)))
      diagnostics.push(
        diagnostic(
          'graph.operation-outside-plan-boundaries',
          `${pointer}/path`,
          `Operation path ${operation.path} is outside authored boundaries.`,
        ),
      );
    if (
      !profile.pathBoundaries.some((value) =>
        pathMatches(operation.path, value),
      )
    )
      diagnostics.push(
        diagnostic(
          'graph.operation-outside-profile-boundaries',
          `${pointer}/path`,
          `Operation path ${operation.path} is outside repository-profile boundaries.`,
        ),
      );
    operations.push(operation);
  }

  const ids = new Set();
  const paths = new Set();
  const outputNames = new Set();
  for (const operation of operations) {
    if (ids.has(operation.id))
      diagnostics.push(
        diagnostic(
          'graph.duplicate-operation-id',
          '/operations',
          `Operation id ${operation.id} is emitted more than once.`,
        ),
      );
    if (paths.has(operation.path))
      diagnostics.push(
        diagnostic(
          'graph.path-conflict',
          '/operations',
          `Multiple operations target path ${operation.path}.`,
        ),
      );
    if (outputNames.has(operation.outputName))
      diagnostics.push(
        diagnostic(
          'graph.duplicate-output-operation',
          '/operations',
          `Multiple operations propose output ${operation.outputName}.`,
        ),
      );
    ids.add(operation.id);
    paths.add(operation.path);
    outputNames.add(operation.outputName);
  }
  for (const output of plan.outputs) {
    if (!outputNames.has(output.name))
      diagnostics.push(
        diagnostic(
          'graph.output-operation-missing',
          '/operations',
          `Declared output ${output.name} has no proposed operation.`,
        ),
      );
  }
  return { operations, conflicts, diagnostics: sortDiagnostics(diagnostics) };
}

function orderOperations(operations) {
  const diagnostics = [];
  const byId = new Map(
    operations.map((operation) => [operation.id, operation]),
  );
  for (const operation of operations) {
    for (const dependency of operation.dependsOn) {
      if (!INPUT_NODE_IDS.has(dependency) && !byId.has(dependency))
        diagnostics.push(
          diagnostic(
            'graph.missing-dependency',
            `/operations/${operation.id}/dependsOn`,
            `Operation ${operation.id} depends on missing node ${dependency}.`,
          ),
        );
      if (dependency === operation.id)
        diagnostics.push(
          diagnostic(
            'graph.dependency-cycle',
            `/operations/${operation.id}/dependsOn`,
            `Operation ${operation.id} depends on itself.`,
          ),
        );
    }
  }
  if (diagnostics.length > 0)
    return { operations: null, diagnostics: sortDiagnostics(diagnostics) };

  const indegree = new Map();
  const dependents = new Map();
  for (const operation of operations) {
    const dependencies = operation.dependsOn.filter((value) => byId.has(value));
    indegree.set(operation.id, dependencies.length);
    for (const dependency of dependencies) {
      const values = dependents.get(dependency) ?? [];
      values.push(operation.id);
      dependents.set(dependency, values);
    }
  }

  const ready = operations
    .filter((operation) => indegree.get(operation.id) === 0)
    .map((operation) => operation.id)
    .sort(compareStrings);
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    for (const dependent of (dependents.get(id) ?? []).sort(compareStrings)) {
      const remaining = indegree.get(dependent) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareStrings);
      }
    }
  }
  return ordered.length === operations.length
    ? { operations: ordered, diagnostics: [] }
    : {
        operations: null,
        diagnostics: [
          diagnostic(
            'graph.dependency-cycle',
            '/operations',
            'Operation dependencies contain a cycle.',
          ),
        ],
      };
}

export function parseRepositoryTaskPlanMarkdown(markdown) {
  if (typeof markdown !== 'string')
    return {
      authoredPlan: null,
      diagnostics: [
        diagnostic(
          'markdown.invalid',
          '',
          'Repository-task plan Markdown must be a string.',
        ),
      ],
    };

  const lines = markdown
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .split('\n');
  if (lines[0] !== '---')
    return {
      authoredPlan: null,
      diagnostics: [
        diagnostic(
          'markdown.front-matter-required',
          '',
          'Repository-task plan Markdown must begin with YAML front matter.',
        ),
      ],
    };
  const closingIndex = lines.indexOf('---', 1);
  if (closingIndex === -1)
    return {
      authoredPlan: null,
      diagnostics: [
        diagnostic(
          'markdown.front-matter-unterminated',
          '',
          'Repository-task plan YAML front matter is not terminated.',
        ),
      ],
    };

  let frontMatter;
  try {
    const document = parseDocument(lines.slice(1, closingIndex).join('\n'), {
      merge: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) throw new Error('Invalid YAML');
    frontMatter = document.toJS({ maxAliasCount: 0 });
  } catch {
    return {
      authoredPlan: null,
      diagnostics: [
        diagnostic(
          'markdown.front-matter-invalid',
          '',
          'Repository-task plan YAML front matter is invalid.',
        ),
      ],
    };
  }
  if (!isObject(frontMatter))
    return {
      authoredPlan: null,
      diagnostics: [
        diagnostic(
          'markdown.front-matter-invalid',
          '',
          'Repository-task plan YAML front matter must be an object.',
        ),
      ],
    };
  if (Object.hasOwn(frontMatter, 'objective'))
    return {
      authoredPlan: null,
      diagnostics: [
        diagnostic(
          'markdown.objective-in-front-matter',
          '/objective',
          'The objective must be authored in the Markdown body.',
        ),
      ],
    };

  const objective = lines
    .slice(closingIndex + 1)
    .join('\n')
    .trim();
  return objective.length > 0
    ? { authoredPlan: { ...frontMatter, objective }, diagnostics: [] }
    : {
        authoredPlan: null,
        diagnostics: [
          diagnostic(
            'markdown.objective-required',
            '/objective',
            'Repository-task plan Markdown must contain an objective body.',
          ),
        ],
      };
}

export function compileRepositoryTaskPlan(markdown, options = {}) {
  const parsed = parseRepositoryTaskPlanMarkdown(markdown);
  if (parsed.diagnostics.length > 0)
    return { generationGraph: null, diagnostics: parsed.diagnostics };

  const normalized = normalizeRepositoryTaskPlan(parsed.authoredPlan);
  if (normalized.diagnostics.length > 0)
    return { generationGraph: null, diagnostics: normalized.diagnostics };

  const profileResult = normalizeProfile(options.profile);
  if (profileResult.diagnostics.length > 0)
    return {
      generationGraph: null,
      diagnostics: profileResult.diagnostics,
    };

  const plan = normalized.normalizedPlan;
  const profile = profileResult.profile;
  const profileDiagnostics = checkPlanAgainstProfile(plan, profile);
  if (profileDiagnostics.length > 0)
    return { generationGraph: null, diagnostics: profileDiagnostics };

  const resolverKey = `${plan.recipe.name}@${plan.recipe.version}`;
  const resolver = options.recipeResolvers?.[resolverKey];
  if (typeof resolver !== 'function')
    return failure(
      'recipe.resolver-unavailable',
      '/recipe',
      `No deterministic resolver is registered for ${resolverKey}.`,
    );

  let resolution;
  try {
    resolution = clone(
      resolver({ normalizedPlan: clone(plan), profile: clone(profile) }),
    );
  } catch {
    return failure(
      'recipe.resolution-failed',
      '/recipe',
      `Recipe resolver ${resolverKey} failed.`,
    );
  }

  const normalizedResolution = normalizeResolution(resolution, plan, profile);
  const ordering = Array.isArray(normalizedResolution.operations)
    ? orderOperations(normalizedResolution.operations)
    : { operations: null, diagnostics: [] };
  const resolutionDiagnostics = sortDiagnostics([
    ...normalizedResolution.diagnostics,
    ...ordering.diagnostics,
  ]);
  if (resolutionDiagnostics.length > 0)
    return { generationGraph: null, diagnostics: resolutionDiagnostics };

  const profileDigest = canonicalJsonDigest(profile);
  const operationByOutput = new Map(
    ordering.operations.map((operation) => [operation.outputName, operation]),
  );
  const graphWithoutDigest = {
    schemaVersion: 1,
    planDigest: plan.planDigest,
    profileDigest,
    repository: plan.repository,
    recipe: { name: plan.recipe.name, version: plan.recipe.version },
    verificationProfile: plan.verificationProfile,
    nodes: [
      {
        id: PLAN_NODE_ID,
        kind: 'input',
        inputKind: 'normalized-plan',
        digest: plan.planDigest,
        dependsOn: [],
      },
      {
        id: PROFILE_NODE_ID,
        kind: 'input',
        inputKind: 'repository-profile',
        digest: profileDigest,
        dependsOn: [],
      },
      ...ordering.operations,
    ],
    outputs: plan.outputs.map((output) => ({
      name: output.name,
      kind: output.kind,
      path: output.path,
      nodeId: operationByOutput.get(output.name).id,
    })),
    conflicts: normalizedResolution.conflicts,
  };
  return {
    generationGraph: {
      ...graphWithoutDigest,
      graphDigest: canonicalJsonDigest(graphWithoutDigest),
    },
    diagnostics: [],
  };
}

export function serializeRepositoryTaskGenerationGraph(generationGraph) {
  return canonicalizeJson(generationGraph);
}

export function replayRepositoryTaskGenerationGraph(serializedGraph) {
  let parsed;
  try {
    parsed = JSON.parse(serializedGraph);
  } catch {
    return failure(
      'graph.invalid-json',
      '',
      'Retained generation graph is not valid JSON.',
    );
  }
  if (
    !isObject(parsed) ||
    typeof parsed.graphDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.graphDigest)
  )
    return failure(
      'graph.invalid',
      '',
      'Retained generation graph has an invalid shape.',
    );

  const { graphDigest, ...graphWithoutDigest } = parsed;
  if (canonicalJsonDigest(graphWithoutDigest) !== graphDigest)
    return failure(
      'graph.digest-mismatch',
      '/graphDigest',
      'Retained generation graph digest does not match its contents.',
    );
  return { generationGraph: clone(parsed), diagnostics: [] };
}
