import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, type Database } from '@factory-floor/db';
import {
  CommandService,
  RegistrationService,
  SystemApplicationService,
  WorkerProtocolService,
  ObservabilityService,
  StartupRecoveryService,
} from '@factory-floor/runtime-core';
import {
  FilesystemArtifactBlobStore,
  type ArtifactBlobStore,
} from '@factory-floor/artifact-store';
import type { Kysely } from 'kysely';
import { parse } from 'yaml';
import { registerRegistrationRoutes } from './routes/registrations.js';
import { registerSystemRoutes } from './routes/systems.js';
import { registerCommandRoutes } from './routes/commands.js';
import { registerWorkerRoutes } from './routes/worker.js';
import { registerInspectionRoutes } from './routes/inspection.js';

export interface AppDependencies {
  database?: Kysely<Database>;
  registrationService?: RegistrationService;
  systemApplicationService?: SystemApplicationService;
  commandService?: CommandService;
  workerProtocolService?: WorkerProtocolService;
  artifactBlobStore?: ArtifactBlobStore;
  workerAuthToken?: string;
  observabilityService?: ObservabilityService;
  startupRecoveryService?: StartupRecoveryService;
  runStartupRecovery?: boolean;
}

export async function buildApp(
  deps: AppDependencies = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    ajv: { customOptions: { removeAdditional: false as never } },
  });
  app.addContentTypeParser(
    ['application/yaml', 'text/yaml', 'application/x-yaml'],
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, parse(String(body)));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );
  app.get('/health', async () => ({
    status: 'ok',
    service: 'control-plane',
  }));

  const db =
    deps.database ??
    (process.env.DATABASE_URL
      ? createDatabase(process.env.DATABASE_URL)
      : undefined);
  const artifactBlobStore =
    deps.artifactBlobStore ??
    (db
      ? new FilesystemArtifactBlobStore(
          process.env.ARTIFACT_STORE_ROOT ?? '.factory-floor/artifacts',
        )
      : undefined);
  const observability =
    deps.observabilityService ?? (db ? new ObservabilityService(db) : undefined);

  if (db || deps.registrationService)
    await registerRegistrationRoutes(
      app,
      deps.registrationService ?? new RegistrationService(db!),
    );
  if (db || deps.systemApplicationService)
    await registerSystemRoutes(
      app,
      deps.systemApplicationService ?? new SystemApplicationService(db!),
    );
  if (db || deps.commandService)
    await registerCommandRoutes(
      app,
      deps.commandService ?? new CommandService(db!),
    );
  if (observability) await registerInspectionRoutes(app, observability);
  if (db || deps.workerProtocolService)
    await registerWorkerRoutes(
      app,
      deps.workerProtocolService ??
        new WorkerProtocolService(db!, artifactBlobStore!, {
          leaseDurationMs: Number(
            process.env.WORKER_LEASE_DURATION_MS ?? 60_000,
          ),
          baseUrl:
            process.env.FACTORY_FLOOR_CONTROL_PLANE_URL ??
            process.env.CONTROL_PLANE_PUBLIC_URL ??
            'http://127.0.0.1:3000',
        }),
      deps.workerAuthToken,
    );

  if (
    deps.runStartupRecovery &&
    (deps.startupRecoveryService || (db && observability))
  ) {
    const recovery =
      deps.startupRecoveryService ??
      new StartupRecoveryService(db!, {
        observability,
        blobStore: artifactBlobStore,
      });
    app.addHook('onReady', async () => {
      const summary = await recovery.run();
      app.log.info({ recovery: summary }, 'startup recovery completed');
    });
  }

  if (!deps.database && db)
    app.addHook('onClose', async () => {
      await db.destroy();
    });
  return app;
}
