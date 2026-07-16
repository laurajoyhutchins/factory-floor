import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, type Database } from '@factory-floor/db';
import {
  CommandService,
  RegistrationService,
  SystemApplicationService,
  WorkerProtocolService,
  WorkerProtocolError,
  ProposedResultPrevalidationService,
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
import {
  registerWorkerRoutes,
  type WorkerAuthorization,
} from './routes/worker.js';
import { registerInspectionRoutes } from './routes/inspection.js';
import {
  registerControlPlaneSecurity,
  type ControlPlaneSecurity,
} from './security.js';

const STARTUP_RECOVERY_BOUNDS = {
  expiredAttempts: 5_000,
  cancellingRegions: 1_000,
  projectionEvents: 100_000,
  stagedArtifacts: 50_000,
} as const;

export interface AppDependencies {
  database?: Kysely<Database>;
  registrationService?: RegistrationService;
  systemApplicationService?: SystemApplicationService;
  commandService?: CommandService;
  workerProtocolService?: WorkerProtocolService;
  artifactBlobStore?: ArtifactBlobStore;
  workerAuthToken?: string;
  workerAuthorization?: WorkerAuthorization;
  observabilityService?: ObservabilityService;
  startupRecoveryService?: StartupRecoveryService;
  runStartupRecovery?: boolean;
  controlPlaneSecurity?: ControlPlaneSecurity;
}

function withResultPrevalidation(
  service: WorkerProtocolService,
  prevalidation: ProposedResultPrevalidationService,
): WorkerProtocolService {
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property === 'submitResult')
        return async (
          input: Parameters<WorkerProtocolService['submitResult']>[0],
        ) => {
          if (!(await prevalidation.hasExistingSubmission(input))) {
            await target.assertActive(input);
            try {
              await prevalidation.prevalidate(input);
            } catch (error) {
              throw new WorkerProtocolError(
                'unauthorized_staging_reference',
                error instanceof Error
                  ? error.message
                  : 'staged artifact validation failed',
                false,
                400,
              );
            }
          }
          return target.submitResult(input);
        };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export async function assertStartupRecoveryWithinBounds(
  db: Kysely<Database>,
  now = new Date(),
): Promise<void> {
  const [expiredRow, cancellingRow, eventsRow, stagingRow] = await Promise.all([
    db
      .selectFrom('execution_attempts')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('status', 'in', ['leased', 'running'])
      .where('lease_expires_at', '<=', now)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('regions')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('lifecycle_status', '=', 'cancelling')
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('events')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('artifact_staging')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('status', '=', 'staged')
      .executeTakeFirstOrThrow(),
  ]);
  const observed = {
    expiredAttempts: Number(expiredRow.count),
    cancellingRegions: Number(cancellingRow.count),
    projectionEvents: Number(eventsRow.count),
    stagedArtifacts: Number(stagingRow.count),
  };
  for (const [name, limit] of Object.entries(STARTUP_RECOVERY_BOUNDS))
    if (observed[name as keyof typeof observed] > limit)
      throw new Error(
        `startup_recovery_backlog_exceeded:${name}:${observed[name as keyof typeof observed]}:${limit}`,
      );
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
  if (deps.controlPlaneSecurity)
    registerControlPlaneSecurity(app, deps.controlPlaneSecurity);
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
    deps.observabilityService ??
    (db ? new ObservabilityService(db) : undefined);

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
  if (db || deps.workerProtocolService) {
    const workerProtocol =
      deps.workerProtocolService ??
      new WorkerProtocolService(db!, artifactBlobStore!, {
        leaseDurationMs: Number(
          process.env.WORKER_LEASE_DURATION_MS ?? 60_000,
        ),
        baseUrl:
          process.env.FACTORY_FLOOR_CONTROL_PLANE_URL ??
          process.env.CONTROL_PLANE_PUBLIC_URL ??
          'http://127.0.0.1:3000',
      });
    await registerWorkerRoutes(
      app,
      db && artifactBlobStore
        ? withResultPrevalidation(
            workerProtocol,
            new ProposedResultPrevalidationService(db, artifactBlobStore),
          )
        : workerProtocol,
      deps.workerAuthorization ?? deps.workerAuthToken,
    );
  }

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
      if (db) await assertStartupRecoveryWithinBounds(db);
      const summary = await recovery.run({
        projectionBatchSize: 250,
        reconciliationBatchSize: 250,
      });
      app.log.info({ recovery: summary }, 'startup recovery completed');
    });
  }

  if (!deps.database && db)
    app.addHook('onClose', async () => {
      await db.destroy();
    });
  return app;
}
