import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import {
  assertMigrationsCurrent,
  createDatabase,
  type Database,
} from '@factory-floor/db';
import {
  FilesystemArtifactBlobStore,
  type ArtifactBlobStore,
} from '@factory-floor/artifact-store';
import { buildApp } from './app.js';
import {
  loadProductionConfig,
  type ProductionControlPlaneConfig,
} from './production-config.js';
import {
  ProductionReadinessService,
  registerProductionHealthRoutes,
} from './production-health.js';

export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface ProductionProcessOptions {
  env?: Record<string, string | undefined>;
  signalSource?: SignalSource;
  build?: typeof buildApp;
  createDatabase?: (databaseUrl: string) => Kysely<Database>;
  createArtifactStore?: (root: string) => ArtifactBlobStore;
  assertMigrations?: (database: Kysely<Database>) => Promise<unknown>;
  assertArtifactStore?: (artifactStore: ArtifactBlobStore) => Promise<unknown>;
  onShutdownError?: (error: unknown) => void;
}

export interface ProductionControlPlaneProcess {
  app: FastifyInstance;
  config: ProductionControlPlaneConfig;
  close(): Promise<void>;
}

async function assertArtifactStoreAvailable(
  artifactStore: ArtifactBlobStore,
): Promise<void> {
  await artifactStore.listStaged({ limit: 1 });
}

export async function startProductionControlPlane(
  options: ProductionProcessOptions = {},
): Promise<ProductionControlPlaneProcess> {
  const env = options.env ?? process.env;
  const signalSource = options.signalSource ?? process;
  const config = loadProductionConfig(env);
  const database = (options.createDatabase ?? createDatabase)(
    config.databaseUrl,
  );
  const artifactStore = (
    options.createArtifactStore ??
    ((root) => new FilesystemArtifactBlobStore(root))
  )(config.artifactStoreRoot);
  const migrationCheck = () =>
    (options.assertMigrations ?? assertMigrationsCurrent)(database);
  const artifactStoreCheck = () =>
    (options.assertArtifactStore ?? assertArtifactStoreAvailable)(
      artifactStore,
    );
  let app: FastifyInstance | undefined;
  let closePromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    closePromise ??= (async () => {
      if (app) await app.close();
      await database.destroy();
    })();
    return closePromise;
  };
  const handleSignal = () => {
    void shutdown().catch(
      options.onShutdownError ?? ((error) => app?.log.error(error)),
    );
  };
  const removeSignalHandlers = () => {
    signalSource.off('SIGTERM', handleSignal);
    signalSource.off('SIGINT', handleSignal);
  };

  try {
    await migrationCheck();
    await artifactStoreCheck();
    app = await (options.build ?? buildApp)({
      database,
      artifactBlobStore: artifactStore,
      runStartupRecovery: true,
      controlPlaneSecurity: config.security,
      workerAuthorization: config.workerAuthorization,
      ...(config.serviceAuthKeys
        ? { serviceAuthKeys: config.serviceAuthKeys }
        : {}),
    });
    registerProductionHealthRoutes(
      app,
      new ProductionReadinessService({
        database: migrationCheck,
        artifactStore: artifactStoreCheck,
      }),
    );

    signalSource.on('SIGTERM', handleSignal);
    signalSource.on('SIGINT', handleSignal);
    await app.listen(config.listener);
  } catch (error) {
    removeSignalHandlers();
    await shutdown().catch(() => undefined);
    throw error;
  }

  return {
    app,
    config,
    close: async () => {
      removeSignalHandlers();
      await shutdown();
    },
  };
}
