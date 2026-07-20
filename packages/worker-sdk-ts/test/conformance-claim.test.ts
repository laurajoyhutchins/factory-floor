import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
    request?: {
      sdkInputAlias?: string;
      componentSelectors?: string[];
      expectedWireBody?: Record<string, unknown>;
    };
    response: {
      status?: number;
      fixture?: string;
      body?: Record<string, unknown> & { envelopeFixture?: string };
      rawBody?: string;
      transportError?: string;
      succeedAfterAttempts?: number;
      successFixture?: string;
    };
    expected: { classification: string; retryable: boolean };
  }>;
};

const claimCaseIds = new Set([
  'claim.claimed',
  'claim.no-work',
  'claim.deprecated-capabilities',
  'response.malformed',
  'transport.retryable',
]);

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, rootUrl), 'utf8')) as unknown;
}

function responseBody(testCase: (typeof corpus.cases)[number]): unknown {
  if (testCase.response.fixture) return fixture(testCase.response.fixture);
  if (testCase.response.body) {
    const { envelopeFixture, ...body } = testCase.response.body;
    return envelopeFixture
      ? { ...body, envelope: fixture(envelopeFixture) }
      : body;
  }
  if (testCase.response.successFixture)
    return fixture(testCase.response.successFixture);
  return {};
}

async function runClaimCase(testCase: (typeof corpus.cases)[number]) {
  let attempts = 0;
  let wireBody: unknown;
  const client = new WorkerProtocolClient({
    baseUrl: 'http://conformance.local',
    bearerToken: 'conformance-token',
    workerId: 'conformance-worker',
    sleep: async () => undefined,
    jitter: () => 0,
    fetch: async (_url, init) => {
      attempts += 1;
      wireBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (
        testCase.response.transportError &&
        attempts <= (testCase.response.succeedAfterAttempts ?? 0)
      )
        throw new TypeError(testCase.response.transportError);
      if (testCase.response.rawBody !== undefined)
        return new Response(testCase.response.rawBody, {
          status: testCase.response.status ?? 200,
        });
      return new Response(JSON.stringify(responseBody(testCase)), {
        status: testCase.response.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  try {
    const result = await client.claim(
      testCase.request?.componentSelectors ?? ['verify@1'],
    );
    if (testCase.request?.expectedWireBody) {
      expect(testCase.request.sdkInputAlias).toBe('capabilities');
      expect(wireBody).toEqual(testCase.request.expectedWireBody);
      expect(wireBody).not.toHaveProperty('capabilities');
    }
    return {
      classification: result.claimed ? 'claimed' : 'no_work',
      retryable: attempts > 1,
    };
  } catch (error) {
    if (!(error instanceof WorkerSdkError)) throw error;
    return {
      classification: error.kind === 'protocol' ? 'protocol_error' : error.kind,
      retryable: error.retryable,
    };
  }
}

describe('TypeScript worker claim conformance', () => {
  for (const testCase of corpus.cases.filter((item) =>
    claimCaseIds.has(item.id),
  ))
    it(testCase.id, async () => {
      await expect(runClaimCase(testCase)).resolves.toEqual(testCase.expected);
    });
});
