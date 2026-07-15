import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, type Database } from '@factory-floor/db';
import {
  CommandService,
  RegistrationService,
  SystemApplicationService,
} from '@factory-floor/runtime-core';
import type { Kysely } from 'kysely';
import { parse } from 'yaml';
import { registerRegistrationRoutes } from './routes/registrations.js';
import { registerSystemRoutes } from './routes/systems.js';
import { registerCommandRoutes } from './routes/commands.js';

export interface AppDependencies {
  database?: Kysely<Database>;
  registrationService?: RegistrationService;
  systemApplicationService?: SystemApplicationService;
  commandService?: CommandService;
}

export async function buildApp(
  deps: AppDependencies = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
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

  if (!deps.database && db)
    app.addHook('onClose', async () => {
      await db.destroy();
    });
  return app;
}
