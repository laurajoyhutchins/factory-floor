export const REPOSITORY_TASK_PLANNER_COMPONENT = {
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
