import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  controlPlaneSecurityFromEnv,
  registerControlPlaneSecurity,
} from '../src/security.js';

describe('control-plane HTTP security', () => {
  it('keeps health public and separates operator reads from admin writes', async () => {
    const app = Fastify();
    registerControlPlaneSecurity(app, {
      operatorToken: 'operator-secret',
      adminToken: 'admin-secret',
    });
    app.get('/health', async () => ({ status: 'ok' }));
    app.get('/api/v1/inspect/events', async () => ({ items: [] }));
    app.post('/api/v1/commands', async () => ({ accepted: true }));

    await expect(app.inject({ method: 'GET', url: '/health' })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(
      app.inject({ method: 'GET', url: '/api/v1/inspect/events' }),
    ).resolves.toMatchObject({ statusCode: 401 });
    await expect(
      app.inject({
        method: 'GET',
        url: '/api/v1/inspect/events',
        headers: { authorization: 'Bearer operator-secret' },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: 'POST',
        url: '/api/v1/commands',
        headers: { authorization: 'Bearer operator-secret' },
      }),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      app.inject({
        method: 'POST',
        url: '/api/v1/commands',
        headers: { authorization: 'Bearer admin-secret' },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });

    await app.close();
  });

  it('does not intercept the separately authenticated worker namespace', async () => {
    const app = Fastify();
    registerControlPlaneSecurity(app, {
      operatorToken: 'operator-secret',
      adminToken: 'admin-secret',
    });
    app.post('/worker/v1/claim', async () => ({ claimed: false }));

    await expect(
      app.inject({ method: 'POST', url: '/worker/v1/claim' }),
    ).resolves.toMatchObject({ statusCode: 200 });

    await app.close();
  });

  it('fails closed when the real server tokens are absent or equal', () => {
    expect(() => controlPlaneSecurityFromEnv({})).toThrow(
      'CONTROL_PLANE_OPERATOR_TOKEN',
    );
    expect(() =>
      controlPlaneSecurityFromEnv({
        CONTROL_PLANE_OPERATOR_TOKEN: 'same',
        CONTROL_PLANE_ADMIN_TOKEN: 'same',
      }),
    ).toThrow('must be different');
    expect(
      controlPlaneSecurityFromEnv({
        CONTROL_PLANE_OPERATOR_TOKEN: 'operator-secret',
        CONTROL_PLANE_ADMIN_TOKEN: 'admin-secret',
      }),
    ).toEqual({
      operatorToken: 'operator-secret',
      adminToken: 'admin-secret',
    });
  });
});
