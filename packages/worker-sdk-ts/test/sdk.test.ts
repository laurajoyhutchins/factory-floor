import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ComponentRegistry,
  WorkerProtocolClient,
  WorkerRunner,
  WorkerSdkError,
  canonicalJson,
  emptyResourceUsage,
  redactSensitive,
  type WorkerComponent,
} from '../src/index.js';
import workerFixture from '../../../contracts/fixtures/worker/invocation-envelope.valid.json' with {
  type: 'json',
};
import type {
  InvocationEnvelope,
  ProposedResult,
  StagedArtifact,
} from '@factory-floor/contracts-ts';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const envelope = workerFixture as InvocationEnvelope;
const activeEnvelope = {
  ...envelope,
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
};

interface ExecutableRunner {
  execute(envelope: InvocationEnvelope, signal?: AbortSignal): Promise<void>;
}

function executable(runner: WorkerRunner): ExecutableRunner {
  return runner as unknown as ExecutableRunner;
}

function runnerClient(overrides: Record<string, unknown> = {}): WorkerProtocolClient {
  return {
    claim: async () => ({
      protocolVersion: '1.0',
      claimed: false,
      retryAfterMs: 100,
    }),
    heartbeat: async () => ({
      protocolVersion: '1.0',
      leaseValid: true,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      cancellation: 'continue',
    }),
    observeCancellation: async () => ({
      protocolVersion: '1.0',
      state: 'continue',
    }),
    stageArtifact: async () => ({
      protocolVersion: '1.0',
      stagedRef: '018f6f73-8d5b-7cc8-9ed9-6b2f4e25d010',
      uploadUrl:
        'http://cp/worker/v1/artifacts/upload/018f6f73-8d5b-7cc8-9ed9-6b2f4e25d010',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    uploadStagedContent: async () => ({
      protocolVersion: '1.0',
      stagedRef: '018f6f73-8d5b-7cc8-9ed9-6b2f4e25d010',
      digest: 'a'.repeat(64),
      sizeBytes: 1,
    }),
    submitResult: async () => ({
      protocolVersion: '1.0',
      accepted: true,
      duplicate: false,
      handoff: 'recorded_for_task_8_commit',
    }),
    invokeCapability: async () => ({
      protocolVersion: '1.0',
      output: {},
      auditId: 'audit',
    }),
    ...overrides,
  } as unknown as WorkerProtocolClient;
}

describe('WorkerProtocolClient', () => {
  it('parses canonical invocation fixture and sends auth headers', async () => {
    let auth = '';
    const client = new WorkerProtocolClient({
      baseUrl: 'http://cp/',
      bearerToken: 'secret-token',
      workerId: 'w1',
      fetch: async (_url, init) => {
        auth = new Headers(init?.headers).get('authorization') ?? '';
        return response({ protocolVersion: '1.0', claimed: true, envelope });
      },
    });
    const claim = await client.claim(['retrieve@1']);
    expect(claim.claimed).toBe(true);
    expect(auth).toBe('Bearer secret-token');
  });

  it('rejects a claimed response with a malformed invocation envelope', async () => {
    const client = new WorkerProtocolClient({
      baseUrl: 'http://cp/',
      bearerToken: 'secret-token',
      workerId: 'w1',
      fetch: async () =>
        response({ protocolVersion: '1.0', claimed: true, envelope: {} }),
    });

    await expect(client.claim(['retrieve@1'])).rejects.toMatchObject({
      kind: 'protocol',
      retryable: false,
    });
  });

  it('maps typed worker errors and redacts secrets', async () => {
    const client = new WorkerProtocolClient({
      baseUrl: 'http://cp/',
      bearerToken: 'secret-token',
      workerId: 'w1',
      fetch: async () =>
        response(
          {
            protocolVersion: '1.0',
            code: 'stale_lease_token',
            message: 'bad leaseToken=abc',
            retryable: false,
            requestId: 'r1',
          },
          409,
        ),
    });
    await expect(client.heartbeat(envelope)).rejects.toMatchObject({
      kind: 'lease',
      code: 'stale_lease_token',
    });
    expect(
      redactSensitive(
        'Bearer secret-token uploadUrl=http://x/y?sig=1 leaseToken=abc',
      ),
    ).not.toContain('secret-token');
  });

  it('retries transient claims with deterministic backoff', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new WorkerProtocolClient({
      baseUrl: 'http://cp/',
      bearerToken: 't',
      workerId: 'w1',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      jitter: () => 0,
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? response(
              {
                protocolVersion: '1.0',
                code: 'internal_transient_failure',
                message: 'try again',
                retryable: true,
                requestId: 'r1',
              },
              503,
            )
          : response({
              protocolVersion: '1.0',
              claimed: false,
              retryAfterMs: 100,
            });
      },
    });
    await expect(client.claim(['retrieve@1'])).resolves.toMatchObject({
      claimed: false,
    });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([50]);
  });

  it('does not retry a consumed Readable upload body', async () => {
    let calls = 0;
    const client = new WorkerProtocolClient({
      baseUrl: 'http://cp/',
      bearerToken: 't',
      workerId: 'w1',
      fetch: async (_url, init) => {
        calls += 1;
        const body = init?.body;
        if (body instanceof Readable) {
          for await (const _chunk of body) {
            // Consume the one-shot stream before simulating transport failure.
          }
        }
        throw new TypeError('network unavailable');
      },
    });

    await expect(
      client.uploadStagedContent(
        'http://cp/worker/v1/artifacts/upload/018f6f73-8d5b-7cc8-9ed9-6b2f4e25d010',
        Readable.from(Buffer.from('data')),
        { retries: 2 },
      ),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(calls).toBe(1);
  });

  it('covers heartbeat cancellation stage upload result and capability operations', async () => {
    const seen: string[] = [];
    const client = new WorkerProtocolClient({
      baseUrl: 'http://cp/',
      bearerToken: 't',
      workerId: 'w1',
      fetch: async (url, init) => {
        seen.push(`${init?.method} ${url}`);
        if (String(url).includes('heartbeat'))
          return response({
            protocolVersion: '1.0',
            leaseValid: true,
            leaseExpiresAt: new Date(Date.now() + 1000).toISOString(),
            cancellation: 'continue',
          });
        if (String(url).includes('cancellation'))
          return response({ protocolVersion: '1.0', state: 'continue' });
        if (String(url).includes('stage'))
          return response({
            protocolVersion: '1.0',
            stagedRef: 's1',
            uploadUrl: 'http://cp/worker/v1/artifacts/upload/s1',
          });
        if (String(url).includes('upload'))
          return response({
            protocolVersion: '1.0',
            stagedRef: 's1',
            digest: 'a'.repeat(64),
            sizeBytes: 2,
          });
        if (String(url).includes('results'))
          return response({
            protocolVersion: '1.0',
            accepted: true,
            duplicate: false,
            handoff: 'recorded_for_task_8_commit',
          });
        return response({
          protocolVersion: '1.0',
          output: { ok: true },
          auditId: 'a1',
        });
      },
    });
    await client.heartbeat(envelope);
    await client.observeCancellation(envelope);
    await client.stageArtifact(envelope, {
      portName: 'out',
      mediaType: 'text/plain',
      expectedDigest: 'a'.repeat(64),
      expectedSizeBytes: 2,
      metadata: {},
    });
    await client.uploadStagedContent(
      'http://cp/worker/v1/artifacts/upload/s1',
      new Uint8Array([1, 2]),
    );
    await client.invokeCapability(envelope, 'handle', {});
    await client.submitResult(
      {
        protocolVersion: '1.0',
        executionId: envelope.executionId,
        attemptId: envelope.attemptId,
        leaseToken: envelope.leaseToken,
        lifecycleEpoch: envelope.lifecycleEpoch,
        status: 'cancelled',
        stagedArtifacts: [],
        proposedEvents: [],
        externalActionProposals: [],
        resourceUsage: emptyResourceUsage(),
      },
      envelope.resultSubmissionUrl,
    );
    expect(seen.length).toBeGreaterThanOrEqual(6);
  });

  it('supports registry lookup and canonical json byte identity', () => {
    const registry = new ComponentRegistry();
    registry.register('retrieve', '1', async () => {
      throw new Error('unused');
    });
    expect(registry.capabilities()).toEqual(['retrieve@1']);
    expect(new TextDecoder().decode(canonicalJson({ b: 1, a: 2 }))).toBe(
      '{"a":2,"b":1}',
    );
  });

  it('classifies conflicting result responses', async () => {
    const client = new WorkerProtocolClient({
      baseUrl: 'http://cp/',
      bearerToken: 't',
      workerId: 'w1',
      fetch: async () =>
        response(
          {
            protocolVersion: '1.0',
            code: 'duplicate_conflicting_result',
            message: 'conflict',
            retryable: false,
            requestId: 'r1',
          },
          409,
        ),
    });
    await expect(
      client.submitResult(
        {
          protocolVersion: '1.0',
          executionId: 'e',
          attemptId: 'a',
          leaseToken: 'l',
          lifecycleEpoch: 1,
          status: 'cancelled',
          stagedArtifacts: [],
          proposedEvents: [],
          externalActionProposals: [],
          resourceUsage: emptyResourceUsage(),
        },
        '/worker/v1/results',
      ),
    ).rejects.toBeInstanceOf(WorkerSdkError);
  });
});

describe('WorkerRunner', () => {
  it('preserves Uint8Array bytes through stageBinary', async () => {
    const registry = new ComponentRegistry();
    const source = new Uint8Array([0, 255, 1, 2]);
    let uploaded = new Uint8Array();
    let submitted: ProposedResult | undefined;

    const component: WorkerComponent = async (context) => {
      const artifact = await context.stageBinary(
        'evidence',
        source,
        'application/octet-stream',
        { schemaId: 'evidence.v1', schemaDigest: 'b'.repeat(64) },
      );
      return {
        status: 'completed',
        stagedArtifacts: [artifact],
        proposedEvents: [],
        externalActionProposals: [],
        resourceUsage: emptyResourceUsage(),
      };
    };
    registry.register('retrieve', '1', component);

    const client = runnerClient({
      stageArtifact: async () => ({
        protocolVersion: '1.0',
        stagedRef: '018f6f73-8d5b-7cc8-9ed9-6b2f4e25d010',
        uploadUrl:
          'http://cp/worker/v1/artifacts/upload/018f6f73-8d5b-7cc8-9ed9-6b2f4e25d010',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      uploadStagedContent: async (_url: string, content: BodyInit) => {
        uploaded = new Uint8Array(await new Response(content).arrayBuffer());
        return {
          protocolVersion: '1.0',
          stagedRef: '018f6f73-8d5b-7cc8-9ed9-6b2f4e25d010',
          digest: createHash('sha256').update(uploaded).digest('hex'),
          sizeBytes: uploaded.byteLength,
        };
      },
      submitResult: async (result: ProposedResult) => {
        submitted = result;
        return {
          protocolVersion: '1.0',
          accepted: true,
          duplicate: false,
          handoff: 'recorded_for_task_8_commit',
        };
      },
    });

    const runner = new WorkerRunner({ client, registry });
    await executable(runner).execute(activeEnvelope);

    expect([...uploaded]).toEqual([...source]);
    expect(submitted?.status).toBe('completed');
    expect((submitted?.stagedArtifacts[0] as StagedArtifact).sizeBytes).toBe(4);
  });

  it('submits a failed proposed result when a component throws', async () => {
    const registry = new ComponentRegistry();
    registry.register('retrieve', '1', async () => {
      throw new Error('secret component failure');
    });
    let submitted: ProposedResult | undefined;
    const client = runnerClient({
      submitResult: async (result: ProposedResult) => {
        submitted = result;
        return {
          protocolVersion: '1.0',
          accepted: true,
          duplicate: false,
          handoff: 'recorded_for_task_8_commit',
        };
      },
    });

    const runner = new WorkerRunner({ client, registry });
    await executable(runner).execute(activeEnvelope);

    expect(submitted).toMatchObject({
      status: 'failed',
      failure: {
        code: 'WORKER_COMPONENT_ERROR',
        category: 'unknown',
        retryable: true,
      },
    });
    expect(JSON.stringify(submitted)).not.toContain('secret component failure');
  });
});
