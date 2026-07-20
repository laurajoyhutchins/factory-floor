import { describe, expect, it, vi } from 'vitest';
import type { ActivitySessionCredentials } from './contracts.js';
import { ActivitySessionController } from './session.js';

describe('Activity session lifecycle', () => {
  it('rotates the in-memory token before idle expiry without extending absolute expiry', async () => {
    let now = Date.parse('2026-07-20T19:00:00.000Z');
    const scheduled: Array<() => void> = [];
    const onSession = vi.fn();
    const refresh = vi.fn(async () => ({
      sessionToken: 'rotated-token',
      expiresAt: '2026-07-20T20:00:00.000Z',
      idleExpiresAt: '2026-07-20T19:10:00.000Z',
    }));
    const controller = new ActivitySessionController(
      {
        sessionToken: 'initial-token',
        expiresAt: '2026-07-20T20:00:00.000Z',
        idleExpiresAt: '2026-07-20T19:05:00.000Z',
      },
      {
        now: () => now,
        refresh,
        schedule: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
        cancel: vi.fn(),
        onSession,
      },
    );

    controller.start();
    expect(scheduled).toHaveLength(1);
    now = Date.parse('2026-07-20T19:04:00.000Z');
    scheduled.shift()?.();
    await vi.waitFor(() =>
      expect(refresh).toHaveBeenCalledWith('initial-token'),
    );
    expect(controller.current().sessionToken).toBe('rotated-token');
    expect(controller.current().expiresAt).toBe('2026-07-20T20:00:00.000Z');
    expect(onSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionToken: 'rotated-token' }),
    );
  });

  it('coalesces overlapping scheduled and reconnect refresh triggers', async () => {
    let resolveRefresh!: (session: ActivitySessionCredentials) => void;
    const refresh = vi.fn(
      () =>
        new Promise<ActivitySessionCredentials>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const controller = new ActivitySessionController(
      {
        sessionToken: 'initial-token',
        expiresAt: '2026-07-20T20:00:00.000Z',
        idleExpiresAt: '2026-07-20T19:05:00.000Z',
      },
      {
        now: () => Date.parse('2026-07-20T19:04:00.000Z'),
        refresh,
        schedule: vi.fn(() => 1),
        cancel: vi.fn(),
      },
    );

    const scheduledRefresh = controller.refreshNow();
    const reconnectRefresh = controller.refreshNow();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('initial-token');

    resolveRefresh({
      sessionToken: 'rotated-token',
      expiresAt: '2026-07-20T20:00:00.000Z',
      idleExpiresAt: '2026-07-20T19:10:00.000Z',
    });
    await Promise.all([scheduledRefresh, reconnectRefresh]);

    expect(controller.state()).toBe('active');
    expect(controller.current().sessionToken).toBe('rotated-token');
  });

  it('fails closed and scrubs credentials when refresh returns an expired session', async () => {
    const onExpired = vi.fn();
    const controller = new ActivitySessionController(
      {
        sessionToken: 'initial-token',
        expiresAt: '2026-07-20T19:01:00.000Z',
        idleExpiresAt: '2026-07-20T19:01:00.000Z',
      },
      {
        now: () => Date.parse('2026-07-20T19:02:00.000Z'),
        refresh: async () => {
          throw new Error('activity_session_expired');
        },
        schedule: (callback) => {
          callback();
          return 1;
        },
        cancel: vi.fn(),
        onExpired,
      },
    );

    controller.start();
    await vi.waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
    expect(controller.state()).toBe('expired');
    expect(controller.current().sessionToken).toBe('');
  });

  it('scrubs credentials when stopped', () => {
    const controller = new ActivitySessionController(
      {
        sessionToken: 'initial-token',
        expiresAt: '2026-07-20T20:00:00.000Z',
        idleExpiresAt: '2026-07-20T19:05:00.000Z',
      },
      {
        now: () => Date.parse('2026-07-20T19:00:00.000Z'),
        refresh: vi.fn(),
        schedule: vi.fn(() => 1),
        cancel: vi.fn(),
      },
    );

    controller.start();
    controller.stop();

    expect(controller.state()).toBe('stopped');
    expect(controller.current().sessionToken).toBe('');
  });

  it('keeps transient offline failures disconnected and retries without persisting credentials', async () => {
    const scheduled: Array<() => void> = [];
    const onState = vi.fn();
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({
        sessionToken: 'rotated-token',
        expiresAt: '2026-07-20T20:00:00.000Z',
        idleExpiresAt: '2026-07-20T19:10:00.000Z',
      });
    const controller = new ActivitySessionController(
      {
        sessionToken: 'initial-token',
        expiresAt: '2026-07-20T20:00:00.000Z',
        idleExpiresAt: '2026-07-20T19:05:00.000Z',
      },
      {
        now: () => Date.parse('2026-07-20T19:04:00.000Z'),
        refresh,
        schedule: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
        cancel: vi.fn(),
        onState,
      },
    );

    controller.start();
    scheduled.shift()?.();
    await vi.waitFor(() =>
      expect(onState).toHaveBeenCalledWith('disconnected'),
    );
    expect(scheduled.length).toBeGreaterThan(0);
    scheduled.shift()?.();
    await vi.waitFor(() => expect(controller.state()).toBe('active'));
    expect(controller.current().sessionToken).toBe('rotated-token');
  });
});
