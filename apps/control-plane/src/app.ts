import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, type Database } from '@factory-floor/db';
import {
  CommandService,
  RegistrationService,
  SystemApplicationService,
  WorkerProtocolService,
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

export interface AppDependencies {
  database?: Kysely<Database>;
  registrationService?: RegistrationService;
  systemApplicationService?: SystemApplicationService;
  commandService?: CommandService;
  workerProtocolService?: WorkerProtocolService;
  artifactBlobStore?: ArtifactBlobStore;
  workerAuthToken?: string;
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
  if (db || deps.workerProtocolService)
    await registerWorkerRoutes(
      app,
      deps.workerProtocolService ??
        new WorkerProtocolService(
          db!,
          deps.artifactBlobStore ??
            new FilesystemArtifactBlobStore(
              process.env.ARTIFACT_STORE_ROOT ?? '.factory-floor/artifacts',
            ),
          {
            baseUrl:
              process.env.CONTROL_PLANE_PUBLIC_URL ?? 'http://127.0.0.1:3000',
          },
        ),
      deps.workerAuthToken,
    );
  if (!deps.database && db)
    app.addHook('onClose', async () => {
      await db.destroy();
    });
  return app;
}
