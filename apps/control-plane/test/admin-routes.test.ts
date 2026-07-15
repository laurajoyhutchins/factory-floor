/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';

describe('control-plane route mapping', () => {
  it('keeps health and maps independently injected services', async () => {
    const submit = vi.fn().mockResolvedValue({
      commandId: 'command-1',
      status: 'accepted',
      correlationId: 'correlation-1',
      eventId: 'event-1',
      deliveryIds: ['delivery-1'],
      disposition: 'accepted',
    });
    const app = await buildApp({
      registrationService: {
        registerArtifactSchema: async () => ({
          disposition: 'created',
          digest: 'd'.repeat(64),
          entity: { id: '1' },
        }),
      } as any,
      systemApplicationService: {
        apply: async () => ({
          disposition: 'existing',
          digest: 'e'.repeat(64),
          regions: [],
        }),
      } as any,
      commandService: { submit } as any,
    });

    expect((await app.inject('/health')).statusCode).toBe(200);
    const registration = await app.inject({
      method: 'POST',
      url: '/api/v1/registrations/artifact-schemas',
      payload: {},
    });
    expect(registration.statusCode).toBe(201);
    const system = await app.inject({
      method: 'POST',
      url: '/api/v1/systems/apply',
      payload: {},
    });
    expect(system.statusCode).toBe(200);
    const command = await app.inject({
      method: 'POST',
      url: '/api/v1/commands',
      payload: {
        region: '/investigation',
        commandType: 'investigation.start',
        payload: { objective: 'test' },
      },
    });
    expect(command.statusCode).toBe(202);
    expect(submit).toHaveBeenCalledWith({
      region: '/investigation',
      commandType: 'investigation.start',
      source: {},
      payload: { objective: 'test' },
      correlationId: undefined,
      idempotencyKey: undefined,
      expiresAt: undefined,
    });

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/commands',
      payload: { region: '', commandType: 'investigation.start' },
    });
    expect(malformed.statusCode).toBe(400);
    await app.close();
  });
});
