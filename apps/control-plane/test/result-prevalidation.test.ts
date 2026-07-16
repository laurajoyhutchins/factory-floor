import { describe, expect, it, vi } from 'vitest';
import {
  ArtifactDomainError,
  WorkerProtocolError,
} from '@factory-floor/runtime-core';
import { withResultPrevalidation } from '../src/app.js';

const proposedResult = {
  protocolVersion: '1.0',
  executionId: '00000000-0000-4000-8000-000000000001',
  attemptId: '00000000-0000-4000-8000-000000000002',
  leaseToken: 'lease',
  lifecycleEpoch: 0,
  status: 'completed',
  stagedArtifacts: [],
  proposedEvents: [],
  externalActionProposals: [],
  resourceUsage: {
    cpuMilliseconds: 0,
    wallMilliseconds: 0,
    inputBytes: 0,
    outputBytes: 0,
    externalCalls: 0,
  },
} as const;

function wrapped(prevalidationError: Error) {
  const submitResult = vi.fn(async () => ({ accepted: true }));
  const service = {
    assertActive: vi.fn(async () => undefined),
    submitResult,
  };
  const prevalidation = {
    hasExistingSubmission: vi.fn(async () => false),
    prevalidate: vi.fn(async () => {
      throw prevalidationError;
    }),
  };
  return {
    service,
    prevalidation,
    wrapped: withResultPrevalidation(
      service as never,
      prevalidation as never,
    ),
  };
}

describe('worker result prevalidation boundary', () => {
  it('maps artifact-domain validation failures to a non-retryable worker error', async () => {
    const { wrapped: service } = wrapped(
      new ArtifactDomainError('invalid_json', 'artifact is not valid JSON'),
    );

    await expect(service.submitResult(proposedResult as never)).rejects.toMatchObject({
      name: WorkerProtocolError.name,
      code: 'unauthorized_staging_reference',
      retryable: false,
      statusCode: 400,
    });
  });

  it('preserves transient infrastructure failures for the route-level retryable 500', async () => {
    const storageError = new Error('artifact store unavailable');
    const { wrapped: service } = wrapped(storageError);

    await expect(service.submitResult(proposedResult as never)).rejects.toBe(
      storageError,
    );
  });
});
