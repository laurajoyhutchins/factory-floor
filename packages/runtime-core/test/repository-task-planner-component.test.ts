import { describe, expect, it } from 'vitest';
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
