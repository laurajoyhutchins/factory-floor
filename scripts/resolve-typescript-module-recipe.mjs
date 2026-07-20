import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const PLAN_NODE_ID = 'input:normalized-plan';
const PROFILE_NODE_ID = 'input:repository-profile';

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic(code, path, message) {
  return { code, severity: 'error', path, message };
}

function failure(code, path, message) {
  return {
    operations: [],
    conflicts: [],
    diagnostics: [diagnostic(code, path, message)],
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareStrings)
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function collapseWhitespace(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function contentDigest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function quoteString(value) {
  return `'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')}'`;
}

function isIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function renderScalar(value) {
  return typeof value === 'string' ? quoteString(value) : JSON.stringify(value);
}

function renderValueLines(value, indentation = 0) {
  const indent = ' '.repeat(indentation);
  if (!Array.isArray(value) && !isObject(value))
    return [`${indent}${renderScalar(value)}`];

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    const lines = [`${indent}[`];
    for (const entry of value) {
      const child = renderValueLines(entry, indentation + 2);
      child[child.length - 1] += ',';
      lines.push(...child);
    }
    lines.push(`${indent}]`);
    return lines;
  }

  const entries = Object.entries(canonicalValue(value));
  if (entries.length === 0) return [`${indent}{}`];
  const lines = [`${indent}{`];
  for (const [key, entry] of entries) {
    const propertyIndent = ' '.repeat(indentation + 2);
    if (!Array.isArray(entry) && !isObject(entry)) {
      const scalar = renderScalar(entry);
      const oneLine = `${propertyIndent}${key}: ${scalar},`;
      if (oneLine.length <= 80) lines.push(oneLine);
      else
        lines.push(
          `${propertyIndent}${key}:`,
          `${' '.repeat(indentation + 4)}${scalar},`,
        );
      continue;
    }

    const child = renderValueLines(entry, indentation + 2);
    lines.push(`${propertyIndent}${key}: ${child[0].trimStart()}`);
    lines.push(...child.slice(1));
    lines[lines.length - 1] += ',';
  }
  lines.push(`${indent}}`);
  return lines;
}

function renderValue(value, indentation = 0) {
  return renderValueLines(value, indentation).join('\n');
}

function renderModule(exports) {
  return `${exports
    .map(
      (entry) =>
        `export const ${entry.name} = ${renderValue(entry.value)} as const;\n\nexport type ${entry.typeName} =\n  typeof ${entry.name};`,
    )
    .join('\n\n')}\n`;
}

function renderTest(moduleName, exports, testCases) {
  const importedNames = exports.map(({ name }) => name).sort(compareStrings);
  const suites = testCases
    .map((testCase) => {
      const expectedLines = renderValueLines(testCase.expected, 4);
      return `describe('${testCase.exportName}', () => {\n  it(${quoteString(
        testCase.name,
      )}, () => {\n    expect(${testCase.exportName}).toEqual(${expectedLines[0].trimStart()}\n${expectedLines
        .slice(1)
        .join('\n')});\n  });\n});`;
    })
    .join('\n\n');
  return `import { describe, expect, it } from 'vitest';\nimport { ${importedNames.join(
    ', ',
  )} } from '../src/${moduleName}.js';\n\n${suites}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function declaredNamePattern(name) {
  return new RegExp(
    `\\b(?:export\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${escapeRegExp(
      name,
    )}\\b`,
  );
}

function normalizeInputs(inputs) {
  if (!isObject(inputs)) return null;
  if (
    typeof inputs.package !== 'string' ||
    typeof inputs.moduleName !== 'string' ||
    typeof inputs.responsibility !== 'string' ||
    !Array.isArray(inputs.exports) ||
    !Array.isArray(inputs.testCases)
  )
    return null;

  const exports = inputs.exports.map((entry) =>
    isObject(entry)
      ? {
          name: entry.name,
          typeName: entry.typeName,
          value: canonicalValue(entry.value),
        }
      : null,
  );
  const testCases = inputs.testCases.map((entry) =>
    isObject(entry)
      ? {
          name:
            typeof entry.name === 'string'
              ? collapseWhitespace(entry.name)
              : entry.name,
          exportName: entry.exportName,
          expected: canonicalValue(entry.expected),
        }
      : null,
  );
  if (
    exports.length === 0 ||
    testCases.length === 0 ||
    exports.some(
      (entry) =>
        entry === null ||
        !isIdentifier(entry.name) ||
        !isIdentifier(entry.typeName),
    ) ||
    testCases.some(
      (entry) =>
        entry === null ||
        typeof entry.name !== 'string' ||
        entry.name.length === 0 ||
        !isIdentifier(entry.exportName),
    )
  )
    return null;

  return {
    package: inputs.package.trim(),
    moduleName: inputs.moduleName.trim(),
    responsibility: collapseWhitespace(inputs.responsibility),
    exports: exports.sort((left, right) =>
      compareStrings(left.name, right.name),
    ),
    testCases: testCases.sort((left, right) =>
      compareStrings(
        [left.exportName, left.name].join('\0'),
        [right.exportName, right.name].join('\0'),
      ),
    ),
  };
}

function outputMap(plan) {
  return new Map(
    plan.outputs.map((output, index) => [output.name, { output, index }]),
  );
}

function operationFor({
  outputName,
  output,
  outputIndex,
  profileIndex,
  recipeKey,
  operation,
  content,
  dependsOn,
  previousContent,
}) {
  const proposal = {
    id: `operation:${outputName}`,
    operation,
    path: output.path,
    outputName,
    mediaType: output.mediaType,
    content,
    contentDigest: contentDigest(content),
    dependsOn: [PLAN_NODE_ID, PROFILE_NODE_ID, ...dependsOn],
    attribution: [
      { kind: 'plan', reference: `/outputs/${outputIndex}` },
      { kind: 'profile', reference: `/packages/${profileIndex}` },
      { kind: 'recipe', reference: `${recipeKey}/${outputName}` },
    ],
  };
  if (previousContent !== undefined)
    proposal.expectedDigest = contentDigest(previousContent);
  return proposal;
}

export function resolveTypescriptModuleRecipe({
  normalizedPlan,
  profile,
  repositorySnapshot,
}) {
  if (!isObject(normalizedPlan) || !isObject(profile))
    return failure(
      'recipe.invalid-context',
      '',
      'Recipe resolution requires a normalized plan and repository profile.',
    );

  const inputs = normalizeInputs(normalizedPlan.recipe?.inputs);
  if (!inputs)
    return failure(
      'recipe.invalid-inputs',
      '/recipe/inputs',
      'The TypeScript module recipe requires responsibility, structured exports, and test cases.',
    );
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(inputs.moduleName))
    return failure(
      'recipe.invalid-module-name',
      '/recipe/inputs/moduleName',
      `Module name ${JSON.stringify(inputs.moduleName)} is not kebab-case.`,
    );

  const packageIndex = Array.isArray(profile.packages)
    ? profile.packages.findIndex((entry) => entry.name === inputs.package)
    : -1;
  if (packageIndex < 0)
    return failure(
      'recipe.package-unknown',
      '/recipe/inputs/package',
      `Package ${inputs.package} is not declared by the repository profile.`,
    );
  const packageEntry = profile.packages[packageIndex];
  const sourcePath = `${packageEntry.path}/${packageEntry.sourceDirectory}/${inputs.moduleName}.ts`;
  const testPath = `${packageEntry.path}/${packageEntry.testDirectory}/${inputs.moduleName}.test.ts`;
  const publicExportPath = `${packageEntry.path}/${packageEntry.publicExportPath}`;
  const expectedPaths = {
    implementation: sourcePath,
    'public-export': publicExportPath,
    'unit-test': testPath,
  };
  const outputs = outputMap(normalizedPlan);
  for (const [name, expectedPath] of Object.entries(expectedPaths)) {
    const declared = outputs.get(name);
    if (!declared || declared.output.path !== expectedPath)
      return failure(
        'recipe.output-path-mismatch',
        '/outputs',
        `Output ${name} must target ${expectedPath}.`,
      );
    if (declared.output.mediaType !== 'text/typescript')
      return failure(
        'recipe.output-media-type-mismatch',
        `/outputs/${declared.index}/mediaType`,
        `Output ${name} must use text/typescript.`,
      );
  }

  const exportNames = new Set();
  const typeNames = new Set();
  for (const entry of inputs.exports) {
    if (exportNames.has(entry.name) || typeNames.has(entry.typeName))
      return failure(
        'recipe.duplicate-export',
        '/recipe/inputs/exports',
        'Declared export names and type names must be unique.',
      );
    exportNames.add(entry.name);
    typeNames.add(entry.typeName);
  }
  for (const testCase of inputs.testCases)
    if (!exportNames.has(testCase.exportName))
      return failure(
        'recipe.test-export-unknown',
        '/recipe/inputs/testCases',
        `Test case references undeclared export ${testCase.exportName}.`,
      );

  const files = isObject(repositorySnapshot?.files)
    ? repositorySnapshot.files
    : {};
  const moduleContent = renderModule(inputs.exports);
  const testContent = renderTest(
    inputs.moduleName,
    inputs.exports,
    inputs.testCases,
  );
  const publicExportStatement = `export * from './${inputs.moduleName}.js';`;
  const currentIndex = files[publicExportPath];
  if (typeof currentIndex !== 'string')
    return failure(
      'recipe.public-export-file-missing',
      '/repositorySnapshot',
      `Public export file ${publicExportPath} is not present in the repository snapshot.`,
    );

  for (const [path, content] of Object.entries(files)) {
    if (path === sourcePath || path === testPath || typeof content !== 'string')
      continue;
    for (const name of exportNames)
      if (declaredNamePattern(name).test(content))
        return failure(
          'recipe.export-name-conflict',
          '/recipe/inputs/exports',
          `Export name ${name} is already declared in ${path}.`,
        );
  }

  const currentModule = files[sourcePath];
  if (currentModule !== undefined && currentModule !== moduleContent)
    return failure(
      'recipe.existing-module-conflict',
      '/repositorySnapshot',
      `Existing module ${sourcePath} cannot be reconciled conservatively.`,
    );
  const currentTest = files[testPath];
  if (currentTest !== undefined && currentTest !== testContent)
    return failure(
      'recipe.existing-test-conflict',
      '/repositorySnapshot',
      `Existing test ${testPath} cannot be reconciled conservatively.`,
    );

  const exportLines = currentIndex.split(/\r?\n/);
  const hasPublicExport = exportLines.includes(publicExportStatement);
  const indexContent = hasPublicExport
    ? currentIndex
    : `${currentIndex.trimEnd()}\n${publicExportStatement}\n`;
  const recipeKey = `${normalizedPlan.recipe.name}@${normalizedPlan.recipe.version}`;
  const operations = [];
  if (currentModule !== moduleContent) {
    const declared = outputs.get('implementation');
    operations.push(
      operationFor({
        outputName: 'implementation',
        output: declared.output,
        outputIndex: declared.index,
        profileIndex: packageIndex,
        recipeKey,
        operation: 'create',
        content: moduleContent,
        dependsOn: [],
      }),
    );
  }
  if (currentIndex !== indexContent) {
    const declared = outputs.get('public-export');
    operations.push(
      operationFor({
        outputName: 'public-export',
        output: declared.output,
        outputIndex: declared.index,
        profileIndex: packageIndex,
        recipeKey,
        operation: 'update',
        content: indexContent,
        previousContent: currentIndex,
        dependsOn: ['operation:implementation'],
      }),
    );
  }
  if (currentTest !== testContent) {
    const declared = outputs.get('unit-test');
    operations.push(
      operationFor({
        outputName: 'unit-test',
        output: declared.output,
        outputIndex: declared.index,
        profileIndex: packageIndex,
        recipeKey,
        operation: 'create',
        content: testContent,
        dependsOn: ['operation:implementation'],
      }),
    );
  }

  const patchBytes = operations.reduce(
    (total, entry) => total + Buffer.byteLength(entry.content, 'utf8'),
    0,
  );
  if (patchBytes > normalizedPlan.resourceBounds.maxPatchBytes)
    return failure(
      'recipe.max-patch-bytes-exceeded',
      '/resourceBounds/maxPatchBytes',
      `Recipe proposal requires ${patchBytes} bytes but the plan allows ${normalizedPlan.resourceBounds.maxPatchBytes}.`,
    );

  return { operations, conflicts: [], diagnostics: [] };
}
