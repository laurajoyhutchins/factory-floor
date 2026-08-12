export const REPOSITORY_TASK_WORKER_COMPONENT = {
  capabilities: [
    'apply-isolated-patch',
    'compile-authored-plan',
    'retain-evidence',
    'run-trusted-verification',
  ],
  name: 'repository-task-worker',
  responsibility:
    'Describe the bounded durable worker that compiles, applies, verifies, and retains repository-task evidence.',
} as const;

export type RepositoryTaskWorkerComponent =
  typeof REPOSITORY_TASK_WORKER_COMPONENT;
