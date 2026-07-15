import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';

const uuid = '018f6f73-8d5b-7cc8-9ed9-6b2f4e25d001';
const workerHeaders = { authorization: 'Bearer worker-token' };

function createService() {
  return {
    claim: vi.fn(async () => ({
      protocolVersion: '1.0',
      claimed: false,
      retryAfterMs: 250,
    })),
    heartbeat: vi.fn(async () => ({
      protocolVersion: '1.0',
      leaseValid: true,
      leaseExpiresAt: new Date().toISOString(),
      cancellation: 'continue',
    })),
    cancellation: vi.fn(async () => ({
      protocolVersion: '1.0',
      state: 'continue',
    })),
    stage: vi.fn(async () => ({
      protocolVersion: '1.0',
      stagedRef: uuid,
      uploadUrl: `/worker/v1/artifacts/upload/${uuid}`,
      expiresAt: new Date().toISOString(),
    })),
    upload: vi.fn(async (_stagedRef: string, _input: unknown, stream: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return {
        protocolVersion: '1.0',
        stagedRef: uuid,
        digest: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7',
        sizeBytes: Buffer.concat(chunks).length,
      };
    }),
    submitResult: vi.fn(async () => ({
      protocolVersion: '1.0',
      accepted: true,
      duplicate: false,
      handoff: 'recorded_for_task_8_commit',
    })),
    invokeCapability: vi.fn(async () => ({
      protocolVersion: '1.0',
      output: {},
      auditId: 'audit',
    })),
  };
}

describe('worker routes', () => {
  it('rejects missing worker credentials', async () => {
    const service = createService();
    const app = await buildApp({
      workerProtocolService: service as never,
      workerAuthToken: 'worker-token',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/worker/v1/claim',
      payload: { protocolVersion: '1.0', workerId: 'w', capabilities: [] },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('authentication_failure');
  });

  it('rejects invalid worker credentials', async () => {
    const service = createService();
    const app = await buildApp({
      workerProtocolService: service as never,
      workerAuthToken: 'worker-token',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/worker/v1/claim',
      headers: { authorization: 'Bearer operator-token' },
      payload: { protocolVersion: '1.0', workerId: 'w', capabilities: [] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('authentication_failure');
  });

  it('accepts a valid authenticated no-work claim', async () => {
    const service = createService();
    const app = await buildApp({
      workerProtocolService: service as never,
      workerAuthToken: 'worker-token',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/worker/v1/claim',
      headers: workerHeaders,
      payload: { protocolVersion: '1.0', workerId: 'w', capabilities: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ protocolVersion: '1.0', claimed: false });
    expect(service.claim).toHaveBeenCalledOnce();
  });

  it('rejects unsupported protocol versions distinctly', async () => {
    const service = createService();
    const app = await buildApp({
      workerProtocolService: service as never,
      workerAuthToken: 'worker-token',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/worker/v1/heartbeat',
      headers: workerHeaders,
      payload: { protocolVersion: '9.9' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('unsupported_protocol_version');
    expect(service.heartbeat).not.toHaveBeenCalled();
  });

  it('validates worker request bodies against the canonical schema', async () => {
    const service = createService();
    const app = await buildApp({
      workerProtocolService: service as never,
      workerAuthToken: 'worker-token',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/worker/v1/heartbeat',
      headers: workerHeaders,
      payload: { protocolVersion: '1.0', attemptId: uuid },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      protocolVersion: '1.0',
      code: 'invalid_request',
      retryable: false,
    });
    expect(service.heartbeat).not.toHaveBeenCalled();
  });

  it('accepts the retryable failed-result contract emitted by Python workers', async () => {
    const service = createService();
    const app = await buildApp({
      workerProtocolService: service as never,
      workerAuthToken: 'worker-token',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/worker/v1/results',
      headers: workerHeaders,
      payload: {
        protocolVersion: '1.0',
        executionId: uuid,
        attemptId: uuid,
        leaseToken: 'lease',
        lifecycleEpoch: 0,
        stagedArtifacts: [],
        proposedEvents: [],
        externalActionProposals: [],
        resourceUsage: {
          cpuMilliseconds: 0,
          wallMilliseconds: 0,
          inputBytes: 1,
          outputBytes: 0,
          externalCalls: 0,
        },
        status: 'failed',
        failure: {
          code: 'DEMO_FIRST_ATTEMPT_INTENTIONAL_FAILURE',
          message: 'Intentional deterministic first-attempt verifier failure for the demo.',
          category: 'model',
          retryable: true,
          details: {
            attemptNumber: 1,
            derivedFrom: 'invocation.attemptNumber',
          },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(service.submitResult).toHaveBeenCalledOnce();
  });

  it('streams application/octet-stream uploads to the service', async () => {
    const service = createService();
    const app = await buildApp({
      workerProtocolService: service as never,
      workerAuthToken: 'worker-token',
    });
    const query = new URLSearchParams({
      protocolVersion: '1.0',
      executionId: uuid,
      attemptId: uuid,
      leaseToken: 'lease',
      lifecycleEpoch: '0',
    });
    const response = await app.inject({
      method: 'PUT',
      url: `/worker/v1/artifacts/upload/${uuid}?${query.toString()}`,
      headers: { ...workerHeaders, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('data'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stagedRef: uuid, sizeBytes: 4 });
    expect(service.upload).toHaveBeenCalledOnce();
    expect(service.upload.mock.calls[0]?.[1]).toMatchObject({ lifecycleEpoch: 0 });
  });

  it('does not apply the worker error envelope to public routes', async () => {
    const service = createService();
    const app = await buildApp({
      workerProtocolService: service as never,
      workerAuthToken: 'worker-token',
      commandService: {} as never,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/commands',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).not.toHaveProperty('protocolVersion');
    expect(response.json()).not.toHaveProperty('code', 'internal_transient_failure');
  });
});
