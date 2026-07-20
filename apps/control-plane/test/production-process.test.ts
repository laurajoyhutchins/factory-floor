import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startProductionControlPlane } from '../src/production-process.js';

const validEnv = {
  DATABASE_URL: 'postgres://factory_floor:secret@db:5432/factory_floor',
  ARTIFACT_STORE_ROOT: '/var/lib/factory-floor/artifacts',
  FACTORY_FLOOR_CONTROL_PLANE_URL: 'http://127.0.0.1:3000',
  HOST: '127.0.0.1',
  PORT: '3000',
  CONTROL_PLANE_OPERATOR_TOKEN: 'operator-secret',
  CONTROL_PLANE_ADMIN_TOKEN: 'admin-secret',
  WORKER_AUTHORIZATION_JSON: JSON.stringify({
    worker: { token: 'worker-secret', componentSelectors: ['verify@1'] },
  }),
};

function fakeApp() {
  const listen = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const get = vi.fn();
  return {
    app: {
      listen,
      close,
      get,
      log: { error: vi.fn(), warn: vi.fn() },
    } as unknown as FastifyInstance,
    listen,
    close,
    get,
  };
}

function fakeDependencies() {
  const destroy = vi.fn(async () => undefined);
  const listStaged = vi.fn(async () => ({ objects: [] }));
  const database = { destroy } as never;
  const artifactStore = { listStaged } as never;
  return {
    database,
    artifactStore,
    destroy,
    listStaged,
    createDatabase: vi.fn(() => database),
    createArtifactStore: vi.fn(() => artifactStore),
    assertMigrations: vi.fn(async () => undefined),
    assertArtifactStore: vi.fn(async () => undefined),
  };
}

describe('production control-plane process', () => {
  it('validates configuration before creating dependencies or listening', async () => {
    const build = vi.fn();
    const dependencies = fakeDependencies();
    await expect(
      startProductionControlPlane({
        env: {},
        build,
        createDatabase: dependencies.createDatabase,
      }),
    ).rejects.toThrow('DATABASE_URL is required');
    expect(dependencies.createDatabase).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it('probes dependencies before building and listening', async () => {
    const signals = new EventEmitter();
    const { app, listen, get } = fakeApp();
    const dependencies = fakeDependencies();
    const build = vi.fn(async () => app);

    const process = await startProductionControlPlane({
      env: validEnv,
      signalSource: signals,
      build,
      ...dependencies,
    });

    expect(dependencies.assertMigrations).toHaveBeenCalledWith(
      dependencies.database,
    );
    expect(dependencies.assertArtifactStore).toHaveBeenCalledWith(
      dependencies.artifactStore,
    );
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        database: dependencies.database,
        artifactBlobStore: dependencies.artifactStore,
        runStartupRecovery: true,
        controlPlaneSecurity: expect.any(Object),
        workerAuthorization: expect.any(Object),
      }),
    );
    expect(get).toHaveBeenCalledWith('/health/live', expect.any(Function));
    expect(get).toHaveBeenCalledWith('/health/ready', expect.any(Function));
    expect(listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 3000 });
    await process.close();
    expect(dependencies.destroy).toHaveBeenCalledTimes(1);
  });

  it('fails closed on pending migrations before building or listening', async () => {
    const { app, listen } = fakeApp();
    const dependencies = fakeDependencies();
    dependencies.assertMigrations.mockRejectedValueOnce(
      new Error('database migrations pending: 002-latest'),
    );
    const build = vi.fn(async () => app);

    await expect(
      startProductionControlPlane({
        env: validEnv,
        build,
        ...dependencies,
      }),
    ).rejects.toThrow('database migrations pending');

    expect(dependencies.assertArtifactStore).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(dependencies.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'closes the app and database exactly once when receiving %s',
    async (signal) => {
      const signals = new EventEmitter();
      const { app, close } = fakeApp();
      const dependencies = fakeDependencies();
      const process = await startProductionControlPlane({
        env: validEnv,
        signalSource: signals,
        build: async () => app,
        ...dependencies,
      });

      signals.emit(signal);
      signals.emit(signal);
      await process.close();

      expect(close).toHaveBeenCalledTimes(1);
      expect(dependencies.destroy).toHaveBeenCalledTimes(1);
    },
  );

  it('closes all initialized resources when listen fails', async () => {
    const signals = new EventEmitter();
    const { app, close } = fakeApp();
    const dependencies = fakeDependencies();
    vi.mocked(app.listen).mockRejectedValueOnce(new Error('address in use'));

    await expect(
      startProductionControlPlane({
        env: validEnv,
        signalSource: signals,
        build: async () => app,
        ...dependencies,
      }),
    ).rejects.toThrow('address in use');
    expect(close).toHaveBeenCalledTimes(1);
    expect(dependencies.destroy).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });
});
