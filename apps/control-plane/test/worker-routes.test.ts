import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const service = {
  claim: async () => ({ protocolVersion: '1.0', claimed: false, retryAfterMs: 250 }),
  heartbeat: async () => ({ protocolVersion: '1.0', leaseValid: true, leaseExpiresAt: new Date().toISOString(), cancellation: 'continue' }),
  cancellation: async () => ({ protocolVersion: '1.0', state: 'continue' }),
  stage: async () => ({ protocolVersion: '1.0', stagedRef: 'ref', uploadUrl: '/worker/v1/artifacts/upload/ref', expiresAt: new Date().toISOString() }),
  upload: async () => ({ protocolVersion: '1.0', stagedRef: 'ref', digest: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', sizeBytes: 4 }),
  submitResult: async () => ({ protocolVersion: '1.0', accepted: true, duplicate: false, handoff: 'recorded_for_task_8_commit' }),
  invokeCapability: async () => ({ protocolVersion: '1.0', output: {}, auditId: 'audit' }),
};

describe('worker routes', () => {
  it('rejects missing worker credentials', async () => {
    const app = await buildApp({ workerProtocolService: service as never, workerAuthToken: 'worker-token' });
    const res = await app.inject({ method: 'POST', url: '/worker/v1/claim', payload: { protocolVersion: '1.0', workerId: 'w', capabilities: [] } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('authentication_failure');
  });
  it('rejects invalid worker credentials', async () => {
    const app = await buildApp({ workerProtocolService: service as never, workerAuthToken: 'worker-token' });
    const res = await app.inject({ method: 'POST', url: '/worker/v1/claim', headers: { authorization: 'Bearer operator-token' }, payload: { protocolVersion: '1.0', workerId: 'w', capabilities: [] } });
    expect(res.statusCode).toBe(403);
  });
  it('accepts a valid authenticated no-work claim', async () => {
    const app = await buildApp({ workerProtocolService: service as never, workerAuthToken: 'worker-token' });
    const res = await app.inject({ method: 'POST', url: '/worker/v1/claim', headers: { authorization: 'Bearer worker-token' }, payload: { protocolVersion: '1.0', workerId: 'w', capabilities: [] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ protocolVersion: '1.0', claimed: false });
  });
  it('rejects unsupported protocol versions', async () => {
    const app = await buildApp({ workerProtocolService: service as never, workerAuthToken: 'worker-token' });
    const res = await app.inject({ method: 'POST', url: '/worker/v1/heartbeat', headers: { authorization: 'Bearer worker-token' }, payload: { protocolVersion: '9.9' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('unsupported_protocol_version');
  });
});
