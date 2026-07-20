import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileTypescriptModuleRecipePlan } from './compile-typescript-module-recipe-plan.mjs';
import { resolveTypescriptModuleRecipe } from './resolve-typescript-module-recipe.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const packagePath = 'packages/runtime-core';
const sourcePath = `${packagePath}/src/repository-task-planner-component.ts`;
const testPath = `${packagePath}/test/repository-task-planner-component.test.ts`;
const publicExportPath = `${packagePath}/src/index.ts`;
const publicExportStatement =
  "export * from './repository-task-planner-component.js';";
const checkedInIndex = readFileSync(resolve(root, publicExportPath), 'utf8');
const indexBeforeDogfood = checkedInIndex.replace(
  `${publicExportStatement}\n`,
  '',
);

const responsibility =
  'Describe the deterministic repository-task planner boundary and its retained capabilities.';
const componentValue = {
  capabilities: [
    'order-generation-graph',
    'parse-authored-plan',
    'replay-retained-graph',
    'resolve-versioned-recipe',
    'validate-repository-profile',
  ],
  name: 'generation-graph-compiler',
  responsibility,
};

const recipeInputs = {
  package: '@factory-floor/runtime-core',
  moduleName: 'repository-task-planner-component',
  responsibility,
  exports: [
    {
      name: 'REPOSITORY_TASK_PLANNER_COMPONENT',
      typeName: 'RepositoryTaskPlannerComponent',
      value: componentValue,
    },
  ],
  testCases: [
    {
      name: 'describes the deterministic repository-task planner boundary',
      exportName: 'REPOSITORY_TASK_PLANNER_COMPONENT',
      expected: componentValue,
    },
  ],
};

const profile = {
  schemaVersion: 1,
  repository: {
    owner: 'laurajoyhutchins',
    name: 'factory-floor',
  },
  pathBoundaries: [`${packagePath}/**`],
  recipes: { 'typescript-module': ['1'] },
  verificationProfiles: ['package-unit'],
  packages: [
    {
      name: '@factory-floor/runtime-core',
      path: packagePath,
      sourceDirectory: 'src',
      testDirectory: 'test',
      publicExportPath: 'src/index.ts',
    },
  ],
};

const outputs = [
  {
    name: 'implementation',
    kind: 'file',
    path: sourcePath,
    mediaType: 'text/typescript',
    required: true,
  },
  {
    name: 'public-export',
    kind: 'export',
    path: publicExportPath,
    mediaType: 'text/typescript',
    required: true,
  },
  {
    name: 'unit-test',
    kind: 'test',
    path: testPath,
    mediaType: 'text/typescript',
    required: true,
  },
];

const normalizedPlan = {
  schemaVersion: 1,
  objective: 'Bootstrap a retained repository-task planner component.',
  repository: {
    owner: 'laurajoyhutchins',
    name: 'factory-floor',
    baseRevision: '48d2e98259fec887eb6fc8ba7e163023bd074d3b',
  },
  allowedPaths: [publicExportPath, sourcePath, testPath],
  recipe: {
    name: 'typescript-module',
    version: '1',
    inputs: recipeInputs,
  },
  outputs,
  verificationProfile: 'package-unit',
  resourceBounds: {
    maxFiles: 3,
    maxPatchBytes: 32768,
    maxVerificationSeconds: 120,
  },
  requestedCapabilities: [
    'repository.proposePatch',
    'repository.read',
    'verification.request',
  ],
  completionCriteria: [
    'The planner component is publicly exported.',
    'The recipe is idempotent against its accepted output.',
    'The focused unit test passes.',
  ],
  planDigest: '0'.repeat(64),
};

const expectedModule = `export const REPOSITORY_TASK_PLANNER_COMPONENT = {
  capabilities: [
    'order-generation-graph',
    'parse-authored-plan',
    'replay-retained-graph',
    'resolve-versioned-recipe',
    'validate-repository-profile',
  ],
  name: 'generation-graph-compiler',
  responsibility:
    'Describe the deterministic repository-task planner boundary and its retained capabilities.',
} as const;

export type RepositoryTaskPlannerComponent =
  typeof REPOSITORY_TASK_PLANNER_COMPONENT;
`;

const expectedTest = `import { describe, expect, it } from 'vitest';
import { REPOSITORY_TASK_PLANNER_COMPONENT } from '../src/repository-task-planner-component.js';

describe('REPOSITORY_TASK_PLANNER_COMPONENT', () => {
  it('describes the deterministic repository-task planner boundary', () => {
    expect(REPOSITORY_TASK_PLANNER_COMPONENT).toEqual({
      capabilities: [
        'order-generation-graph',
        'parse-authored-plan',
        'replay-retained-graph',
        'resolve-versioned-recipe',
        'validate-repository-profile',
      ],
      name: 'generation-graph-compiler',
      responsibility:
        'Describe the deterministic repository-task planner boundary and its retained capabilities.',
    });
  });
});
`;

const expectedIndex = `${indexBeforeDogfood.trimEnd()}\n${publicExportStatement}\n`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshot(files = {}) {
  return { files: { [publicExportPath]: indexBeforeDogfood, ...files } };
}

function applyOperations(repositorySnapshot, operations) {
  const next = clone(repositorySnapshot);
  for (const operation of operations) {
    if (operation.operation === 'delete') delete next.files[operation.path];
    else next.files[operation.path] = operation.content;
  }
  return next;
}

function resolveRecipe(repositorySnapshot, plan = normalizedPlan) {
  return resolveTypescriptModuleRecipe({
    normalizedPlan: clone(plan),
    profile: clone(profile),
    repositorySnapshot: clone(repositorySnapshot),
  });
}

function operationByOutput(result, outputName) {
  return result.operations.find(
    (operation) => operation.outputName === outputName,
  );
}

describe('deterministic TypeScript module recipe', () => {
  it('proposes the module, meaningful Vitest contract, and public export', () => {
    const result = resolveRecipe(snapshot());

    expect(result.diagnostics).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.operations).toHaveLength(3);
    expect(operationByOutput(result, 'implementation')).toEqual(
      expect.objectContaining({
        id: 'operation:implementation',
        operation: 'create',
        path: sourcePath,
        content: expectedModule,
      }),
    );
    expect(operationByOutput(result, 'unit-test')).toEqual(
      expect.objectContaining({
        id: 'operation:unit-test',
        operation: 'create',
        path: testPath,
        content: expectedTest,
        dependsOn: expect.arrayContaining(['operation:implementation']),
      }),
    );
    expect(operationByOutput(result, 'public-export')).toEqual(
      expect.objectContaining({
        id: 'operation:public-export',
        operation: 'update',
        path: publicExportPath,
        content: expectedIndex,
        dependsOn: expect.arrayContaining(['operation:implementation']),
      }),
    );
    for (const operation of result.operations) {
      expect(operation.contentDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(operation.attribution.map(({ kind }) => kind).sort()).toEqual([
        'plan',
        'profile',
        'recipe',
      ]);
    }
  });

  it('is a no-op against its own accepted output', () => {
    const first = resolveRecipe(snapshot());
    const accepted = applyOperations(snapshot(), first.operations);
    const second = resolveRecipe(accepted);

    expect(second).toEqual({ operations: [], conflicts: [], diagnostics: [] });
  });

  it('fails closed on existing-source, naming, path, and export conflicts', () => {
    const existingSource = resolveRecipe(
      snapshot({ [sourcePath]: 'export const unexpected = true;\n' }),
    );
    expect(existingSource.operations).toEqual([]);
    expect(existingSource.diagnostics.map(({ code }) => code)).toContain(
      'recipe.existing-module-conflict',
    );

    const exportCollision = resolveRecipe(
      snapshot({
        [`${packagePath}/src/other.ts`]:
          'export const REPOSITORY_TASK_PLANNER_COMPONENT = false;\n',
      }),
    );
    expect(exportCollision.operations).toEqual([]);
    expect(exportCollision.diagnostics.map(({ code }) => code)).toContain(
      'recipe.export-name-conflict',
    );

    const invalidName = clone(normalizedPlan);
    invalidName.recipe.inputs.moduleName = 'Not-Kebab';
    const naming = resolveRecipe(snapshot(), invalidName);
    expect(naming.operations).toEqual([]);
    expect(naming.diagnostics.map(({ code }) => code)).toContain(
      'recipe.invalid-module-name',
    );

    const wrongPath = clone(normalizedPlan);
    wrongPath.outputs.find(({ name }) => name === 'implementation').path =
      `${packagePath}/src/wrong.ts`;
    const path = resolveRecipe(snapshot(), wrongPath);
    expect(path.operations).toEqual([]);
    expect(path.diagnostics.map(({ code }) => code)).toContain(
      'recipe.output-path-mismatch',
    );
  });

  it('preserves proposed content in the retained generation graph', () => {
    const markdown = `---
schemaVersion: 1
repository:
  owner: laurajoyhutchins
  name: factory-floor
  baseRevision: 48d2e98259fec887eb6fc8ba7e163023bd074d3b
allowedPaths:
  - ${sourcePath}
  - ${testPath}
  - ${publicExportPath}
recipe:
  name: typescript-module
  version: '1'
  inputs:
    package: '@factory-floor/runtime-core'
    moduleName: repository-task-planner-component
    responsibility: ${JSON.stringify(responsibility)}
    exports:
      - name: REPOSITORY_TASK_PLANNER_COMPONENT
        typeName: RepositoryTaskPlannerComponent
        value:
          name: generation-graph-compiler
          responsibility: ${JSON.stringify(responsibility)}
          capabilities:
            - order-generation-graph
            - parse-authored-plan
            - replay-retained-graph
            - resolve-versioned-recipe
            - validate-repository-profile
    testCases:
      - name: describes the deterministic repository-task planner boundary
        exportName: REPOSITORY_TASK_PLANNER_COMPONENT
        expected:
          name: generation-graph-compiler
          responsibility: ${JSON.stringify(responsibility)}
          capabilities:
            - order-generation-graph
            - parse-authored-plan
            - replay-retained-graph
            - resolve-versioned-recipe
            - validate-repository-profile
outputContract:
  outputs:
    - name: implementation
      kind: file
      path: ${sourcePath}
      mediaType: text/typescript
      required: true
    - name: unit-test
      kind: test
      path: ${testPath}
      mediaType: text/typescript
      required: true
    - name: public-export
      kind: export
      path: ${publicExportPath}
      mediaType: text/typescript
      required: true
verificationProfile: package-unit
resourceBounds:
  maxFiles: 3
  maxPatchBytes: 32768
  maxVerificationSeconds: 120
requestedCapabilities:
  - repository.read
  - repository.proposePatch
  - verification.request
completionCriteria:
  - The planner component is publicly exported.
  - The focused unit test passes.
---
Bootstrap a retained repository-task planner component.
`;
    const result = compileTypescriptModuleRecipePlan(markdown, {
      profile,
      repositorySnapshot: snapshot(),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.generationGraph).not.toBeNull();
    const implementation = result.generationGraph.nodes.find(
      ({ id }) => id === 'operation:implementation',
    );
    expect(implementation.content).toBe(expectedModule);
    expect(implementation.contentDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('matches the checked-in self-hosted planner component exactly', () => {
    const result = resolveRecipe(snapshot());
    const generated = Object.fromEntries(
      result.operations.map(({ path, content }) => [path, content]),
    );

    expect(generated[sourcePath]).toBe(
      readFileSync(resolve(root, sourcePath), 'utf8'),
    );
    expect(generated[testPath]).toBe(
      readFileSync(resolve(root, testPath), 'utf8'),
    );
    expect(generated[publicExportPath]).toBe(checkedInIndex);
  });
});
