import { describe, expect, it } from 'vitest';
import { REPOSITORY_TASK_WORKER_COMPONENT } from '../src/repository-task-worker-component.js';

describe('REPOSITORY_TASK_WORKER_COMPONENT', () => {
  it('describes the bounded durable repository-task worker', () => {
    expect(REPOSITORY_TASK_WORKER_COMPONENT).toEqual({
      capabilities: [
        'apply-isolated-patch',
        'compile-authored-plan',
        'retain-evidence',
        'run-trusted-verification',
      ],
      name: 'repository-task-worker',
      responsibility:
        'Describe the bounded durable worker that compiles, applies, verifies, and retains repository-task evidence.',
    });
  });
});
