import { describe, expect, it } from 'vitest';
import { ComponentRegistry, WorkerProtocolClient, WorkerSdkError, canonicalJson, redactSensitive } from '../src/index.js';
import workerFixture from '../../../contracts/fixtures/worker/invocation-envelope.valid.json' with { type: 'json' };
import type { InvocationEnvelope } from '@factory-floor/contracts-ts';

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
const envelope = workerFixture as InvocationEnvelope;

describe('WorkerProtocolClient', () => {
  it('parses canonical invocation fixture and sends auth headers', async () => {
    let auth = '';
    const client = new WorkerProtocolClient({ baseUrl: 'http://cp/', bearerToken: 'secret-token', workerId: 'w1', fetch: async (_url, init) => { auth = new Headers(init?.headers).get('authorization') ?? ''; return response({ protocolVersion: '1.0', claimed: true, envelope }); } });
    const claim = await client.claim(['retrieve@1']);
    expect(claim.claimed).toBe(true);
    expect(auth).toBe('Bearer secret-token');
  });

  it('maps typed worker errors and redacts secrets', async () => {
    const client = new WorkerProtocolClient({ baseUrl: 'http://cp/', bearerToken: 'secret-token', workerId: 'w1', fetch: async () => response({ protocolVersion: '1.0', code: 'stale_lease_token', message: 'bad leaseToken=abc', retryable: false, requestId: 'r1' }, 409) });
    await expect(client.heartbeat(envelope)).rejects.toMatchObject({ kind: 'lease', code: 'stale_lease_token' });
    expect(redactSensitive('Bearer secret-token uploadUrl=http://x/y?sig=1 leaseToken=abc')).not.toContain('secret-token');
  });

  it('retries transient claims with deterministic backoff', async () => {
    let calls = 0; const sleeps: number[] = [];
    const client = new WorkerProtocolClient({ baseUrl: 'http://cp/', bearerToken: 't', workerId: 'w1', sleep: async (ms) => { sleeps.push(ms); }, jitter: () => 0, fetch: async () => { calls += 1; return calls === 1 ? response({ protocolVersion: '1.0', code: 'internal_transient_failure', message: 'try again', retryable: true, requestId: 'r1' }, 503) : response({ protocolVersion: '1.0', claimed: false, retryAfterMs: 100 }); } });
    await expect(client.claim(['retrieve@1'])).resolves.toMatchObject({ claimed: false });
    expect(calls).toBe(2); expect(sleeps).toEqual([50]);
  });

  it('covers heartbeat cancellation stage upload result and capability operations', async () => {
    const seen: string[] = [];
    const client = new WorkerProtocolClient({ baseUrl: 'http://cp/', bearerToken: 't', workerId: 'w1', fetch: async (url, init) => { seen.push(`${init?.method} ${url}`); if (String(url).includes('heartbeat')) return response({ protocolVersion: '1.0', leaseValid: true, leaseExpiresAt: new Date(Date.now()+1000).toISOString(), cancellation: 'continue' }); if (String(url).includes('cancellation')) return response({ protocolVersion: '1.0', state: 'continue' }); if (String(url).includes('stage')) return response({ protocolVersion: '1.0', stagedRef: 's1', uploadUrl: 'http://cp/worker/v1/artifacts/upload/s1' }); if (String(url).includes('upload')) return response({ protocolVersion: '1.0', stagedRef: 's1', digest: 'a'.repeat(64), sizeBytes: 2 }); if (String(url).includes('results')) return response({ protocolVersion: '1.0', accepted: true, duplicate: false, handoff: {} }); return response({ protocolVersion: '1.0', output: { ok: true }, auditId: 'a1' }); } });
    await client.heartbeat(envelope); await client.observeCancellation(envelope);
    await client.stageArtifact(envelope, { portName: 'out', mediaType: 'text/plain', expectedDigest: 'a'.repeat(64), expectedSizeBytes: 2, metadata: {} });
    await client.uploadStagedContent('http://cp/worker/v1/artifacts/upload/s1', new Uint8Array([1,2]));
    await client.invokeCapability(envelope, 'handle', {});
    await client.submitResult({ protocolVersion: '1.0', executionId: envelope.executionId, attemptId: envelope.attemptId, leaseToken: envelope.leaseToken, lifecycleEpoch: envelope.lifecycleEpoch, status: 'cancelled', stagedArtifacts: [], proposedEvents: [], externalActionProposals: [], resourceUsage: { cpuMilliseconds: 0, wallMilliseconds: 0, inputBytes: 0, outputBytes: 0, externalCalls: 0 } }, envelope.resultSubmissionUrl);
    expect(seen.length).toBeGreaterThanOrEqual(6);
  });

  it('supports registry lookup and canonical json byte identity', () => {
    const registry = new ComponentRegistry(); registry.register('retrieve','1', async () => { throw new Error('unused'); });
    expect(registry.capabilities()).toEqual(['retrieve@1']);
    expect(new TextDecoder().decode(canonicalJson({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  it('classifies conflicting result responses', async () => {
    const client = new WorkerProtocolClient({ baseUrl: 'http://cp/', bearerToken: 't', workerId: 'w1', fetch: async () => response({ protocolVersion: '1.0', code: 'duplicate_conflicting_result', message: 'conflict', retryable: false, requestId: 'r1' }, 409) });
    await expect(client.submitResult({ protocolVersion: '1.0', executionId: 'e', attemptId: 'a', leaseToken: 'l', lifecycleEpoch: 1, status: 'cancelled', stagedArtifacts: [], proposedEvents: [], externalActionProposals: [], resourceUsage: { cpuMilliseconds: 0, wallMilliseconds: 0, inputBytes: 0, outputBytes: 0, externalCalls: 0 } }, '/worker/v1/results')).rejects.toBeInstanceOf(WorkerSdkError);
  });
});
