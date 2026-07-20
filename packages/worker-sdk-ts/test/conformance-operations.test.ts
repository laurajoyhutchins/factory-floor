import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  InvocationEnvelope,
  ProposedResult,
  WorkerStageRequest,
} from '@factory-floor/contracts-ts';
import { WorkerProtocolClient, WorkerSdkError } from '../src/index.js';

const rootUrl = new URL('../../../', import.meta.url);
const corpus = JSON.parse(
  readFileSync(
    new URL('contracts/conformance/worker-protocol-v1.cases.json', rootUrl),
    'utf8',
  ),
) as {
  cases: Array<{
    id: string;
    operation: string;
    request: {
      body?: Record<string, unknown>;
      bodyMutations?: Partial<InvocationEnvelope>;
      fixture?: string;
      uploadBytesUtf8?: string;
    };
    response: {
      status?: number;
      fixture?: string;
      body?: Record<string, unknown>;
    };
    expected: { classification: string; retryable: boolean };
  }>;
};

const operationCaseIds = new Set([
  'heartbeat.lease-error',
  'cancellation.stale-epoch',
  'artifact.stage-upload',
  'capability.denied',
  'result.accepted',
  'result.duplicate-identical',
  'result.duplicate-conflict',
]);

function fixture<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, rootUrl), 'utf8')) as T;
}

function responseBody(testCase: (typeof corpus.cases)[number]): unknown {
  return testCase.response.fixture
    ? fixture(testCase.response.fixture)
    : (testCase.response.body ?? {});
}

function errorClassification(error: WorkerSdkError): string {
  return (
    {
      lease: 'lease_error',
      capability_denied: 'capability_denied',
      conflict: 'conflict',
    }[error.kind] ?? error.kind
  );
}

async function runOperationCase(testCase: (typeof corpus.cases)[number]) {
  const sourceEnvelope = fixture<InvocationEnvelope>(
    'contracts/fixtures/worker/invocation-envelope.valid.json',
  );
  const envelope = {
    ...sourceEnvelope,
    ...testCase.request.bodyMutations,
  } as InvocationEnvelope;
  const uploaded: number[] = [];
  let wireBody: Record<string, unknown> | undefined;
  const client = new WorkerProtocolClient({
    baseUrl: 'http://conformance.local',
    bearerToken: 'conformance-token',
    workerId: 'conformance-worker',
    sleep: async () => undefined,
    jitter: () => 0,
    fetch: async (_url, init) => {
      if (init?.method === 'PUT') {
        uploaded.push(
          ...new Uint8Array(await new Response(init.body).arrayBuffer()),
        );
        const stage = fixture<{ stagedRef: string }>(
          'contracts/fixtures/worker/stage-response.valid.json',
        );
        return new Response(
          JSON.stringify({
            protocolVersion: '1.0',
            stagedRef: stage.stagedRef,
            digest: testCase.request.body?.expectedDigest ?? 'a'.repeat(64),
            sizeBytes: uploaded.length,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      wireBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      return new Response(JSON.stringify(responseBody(testCase)), {
        status: testCase.response.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  try {
    if (testCase.id === 'heartbeat.lease-error')
      await client.heartbeat(envelope);
    else if (testCase.id === 'cancellation.stale-epoch')
      await client.observeCancellation(envelope);
    else if (testCase.id === 'capability.denied') {
      const request = testCase.request.body ?? {};
      await client.invokeCapability(
        envelope,
        String(request.handle),
        (request.input ?? {}) as Record<string, unknown>,
      );
    } else if (testCase.id === 'artifact.stage-upload') {
      const stage = await client.stageArtifact(
        envelope,
        testCase.request.body as Omit<
          WorkerStageRequest,
          | 'protocolVersion'
          | 'executionId'
          | 'attemptId'
          | 'leaseToken'
          | 'lifecycleEpoch'
        >,
      );
      const bytes = new TextEncoder().encode(testCase.request.uploadBytesUtf8);
      await client.uploadStagedContent(stage.uploadUrl, bytes);
      expect(uploaded).toEqual([...bytes]);
      return { classification: 'staged', retryable: false };
    } else {
      const result = fixture<ProposedResult>(testCase.request.fixture!);
      const response = await client.submitResult(
        result,
        envelope.resultSubmissionUrl,
      );
      return {
        classification: response.duplicate ? 'duplicate' : 'accepted',
        retryable: false,
      };
    }
    throw new Error(`case ${testCase.id} unexpectedly succeeded`);
  } catch (error) {
    if (!(error instanceof WorkerSdkError)) throw error;
    if (testCase.id === 'cancellation.stale-epoch')
      expect(wireBody?.lifecycleEpoch).toBe(0);
    return {
      classification: errorClassification(error),
      retryable: error.retryable,
    };
  }
}

describe('TypeScript worker operation conformance', () => {
  for (const testCase of corpus.cases.filter((item) =>
    operationCaseIds.has(item.id),
  ))
    it(testCase.id, async () => {
      await expect(runOperationCase(testCase)).resolves.toEqual(
        testCase.expected,
      );
    });
});
