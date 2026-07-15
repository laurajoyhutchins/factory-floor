import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, type Database } from '@factory-floor/db';
import { RegistrationService, SystemApplicationService } from '@factory-floor/runtime-core';
import type { Kysely } from 'kysely';
import { parse } from 'yaml';
import { registerRegistrationRoutes } from './routes/registrations.js';
import { registerSystemRoutes } from './routes/systems.js';
export interface AppDependencies { database?: Kysely<Database>; registrationService?: RegistrationService; systemApplicationService?: SystemApplicationService; }
export async function buildApp(deps: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  app.addContentTypeParser(['application/yaml','text/yaml','application/x-yaml'], { parseAs:'string' }, (_req, body, done) => { try { done(null, parse(String(body))); } catch(e) { done(e as Error, undefined); } });
  app.get('/health', async () => ({ status: 'ok', service: 'control-plane' }));
  const db = deps.database ?? (process.env.DATABASE_URL ? createDatabase(process.env.DATABASE_URL) : undefined);
  if (db || deps.registrationService || deps.systemApplicationService) {
    const reg = deps.registrationService ?? new RegistrationService(db!);
    const sys = deps.systemApplicationService ?? new SystemApplicationService(db!);
    await registerRegistrationRoutes(app, reg); await registerSystemRoutes(app, sys);
    if (!deps.database && db) app.addHook('onClose', async () => { await db.destroy(); });
  }
  return app;
}
