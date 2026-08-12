import { describe, expect, it } from 'vitest';
import {
  authoredPlan,
  dogfoodPlanTarget,
} from '../examples/repository-task/dogfood-plan.js';

describe('repository-task dogfood plan', () => {
  const baseRevision = '0123456789abcdef0123456789abcdef01234567';

  it('is byte-identical for the same base revision', () => {
    expect(authoredPlan(baseRevision)).toBe(authoredPlan(baseRevision));
    expect(dogfoodPlanTarget(baseRevision)).toEqual(
      dogfoodPlanTarget(baseRevision),
    );
  });

  it('uses a different bounded target for a different base revision', () => {
    const first = dogfoodPlanTarget(baseRevision);
    const second = dogfoodPlanTarget(
      'fedcba9876543210fedcba9876543210fedcba98',
    );

    expect(second).not.toEqual(first);
    expect(second.moduleName).not.toBe(first.moduleName);
    expect(second.exportName).not.toBe(first.exportName);
    expect(second.implementationPath).not.toBe(first.implementationPath);
    expect(second.testPath).not.toBe(first.testPath);
  });

  it('retains the full repository identity while declaring revision-scoped outputs', () => {
    const target = dogfoodPlanTarget(baseRevision);
    const plan = authoredPlan(baseRevision);

    expect(plan).toContain(`baseRevision: ${baseRevision}`);
    expect(plan).toContain(`moduleName: ${target.moduleName}`);
    expect(plan).toContain(`- name: ${target.exportName}`);
    expect(plan).toContain(`path: ${target.implementationPath}`);
    expect(plan).toContain(`path: ${target.testPath}`);
    expect(plan).toContain('path: workers/repository-task-ts/src/index.ts');
  });
});
