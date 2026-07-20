import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_REPOSITORY_TASK_CAPABILITIES,
  normalizeRepositoryTaskPlan,
} from './normalize-repository-task-plan.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureDirectory = resolve(root, 'contracts/fixtures/repository-task');

function fixture(name) {
  return JSON.parse(readFileSync(resolve(fixtureDirectory, name), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyPointerMutation(target, mutation) {
  const segments = mutation.path
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  const property = segments.pop();
  let current = target;
  for (const segment of segments) current = current[segment];
  current[property] = mutation.value;
}

const minimalPlan = fixture('minimal-authored-plan.valid.json');
const equivalentPlan = fixture('equivalent-authored-plan.valid.json');
const expectedNormalizedPlan = fixture('minimal-normalized-plan.valid.json');
const invalidCases = fixture('invalid-authored-plans.cases.json').cases;

describe('repository-task plan normalization', () => {
  it('normalizes a minimal plan to the stable canonical fixture and digest', () => {
    const result = normalizeRepositoryTaskPlan(minimalPlan);

    expect(result.diagnostics).toEqual([]);
    expect(result.normalizedPlan).toEqual(expectedNormalizedPlan);
  });

  it('normalizes semantically equivalent authored plans identically', () => {
    const first = normalizeRepositoryTaskPlan(minimalPlan);
    const second = normalizeRepositoryTaskPlan(equivalentPlan);

    expect(second.diagnostics).toEqual([]);
    expect(second.normalizedPlan).toEqual(first.normalizedPlan);
  });

  it.each(invalidCases)(
    'rejects $id with stable diagnostic $expectedCode',
    ({ mutation, expectedCode }) => {
      const invalid = clone(minimalPlan);
      applyPointerMutation(invalid, mutation);

      const result = normalizeRepositoryTaskPlan(invalid, {
        allowedCapabilities: DEFAULT_ALLOWED_REPOSITORY_TASK_CAPABILITIES,
      });

      expect(result.normalizedPlan).toBeNull();
      expect(
        result.diagnostics.map((diagnostic) => diagnostic.code),
      ).toContain(expectedCode);
    },
  );
});
