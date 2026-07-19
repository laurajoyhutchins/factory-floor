import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, createUuidV7, type Database } from '@factory-floor/db';
import {
  ArtifactDomainError,
  CommandService,
  ObservabilityService,
  OperatorCommandService,
  OperatorQueryService,
  PROJECTION_NAMES,
  ProposedResultPrevalidationService,
  RegistrationService,
  StartupRecoveryService,
  SystemApplicationService,
  WorkerProtocolError,
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
import {
  registerWorkerRoutes,
  type WorkerAuthorization,
} from './routes/worker.js';
import { registerInspectionRoutes } from './routes/inspection.js';
import { registerOperatorRoutes } from './routes/operator.js';
import {
  registerControlPlaneSecurity,
  type ControlPlaneSecurity,
} from './security.js';
import {
  registerServiceAuth,
  type ServiceAuthConfig,
  type ServiceAuthKeys,
} from './service-auth.js';
import { createNonceRepository } from './nonce-repository.js';
import { ActivitySessionService } from './activity-session-service.js';
import { registerActivityRoutes } from './routes/activity.js';

export interface StartupRecoveryBounds {
  expiredAttempts: number;
  cancellingRegions: number;
  stagedArtifacts: number;
}

const STARTUP_RECOVERY_BOUNDS: StartupRecoveryBounds = {
  expiredAttempts: 5_000,
  cancellingRegions: 1_000,
  stagedArtifacts: 50_000,
};
const STARTUP_PROJECTOR_VERSION = 'task10.v2';

export interface AppDependencies {
  database?: Kysely<Database>;
  registrationService?: RegistrationService;
  systemApplicationService?: SystemApplicationService;
  commandService?: CommandService;
  operatorCommandService?: OperatorCommandService;
  operatorQueryService?: OperatorQueryService;
  workerProtocolService?: WorkerProtocolService;
  artifactBlobStore?: ArtifactBlobStore;
  workerAuthToken?: string;
  workerAuthorization?: WorkerAuthorization;
  observabilityService?: ObservabilityService;
  startupRecoveryService?: StartupRecoveryService;
  runStartupRecovery?: boolean;
  controlPlaneSecurity?: ControlPlaneSecurity;
  serviceAuthKeys?: ServiceAuthKeys;
}

export type { ServiceAuthKeys, ServiceAuthConfig } from './service-auth.js';

export function withResultPrevalidation(
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
              if (error instanceof ArtifactDomainError)
                throw new WorkerProtocolError(
                  'unauthorized_staging_reference',
                  error.message,
                  false,
                  400,
                );
              throw error;
            }
          }
          return target.submitResult(input);
        };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export class BoundedStartupObservabilityService extends ObservabilityService {
  constructor(private readonly startupDb: Kysely<Database>) {
    super(startupDb);
  }

  override async rebuildProjections(batchSize = 500) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000)
      throw new Error('invalid_batch_size');

    const checkpoints = await this.startupDb
      .selectFrom('projection_checkpoints')
      .selectAll()
      .where('stream_key', '=', 'global')
      .where('projection_name', 'in', [...PROJECTION_NAMES])
      .execute();
    const complete = PROJECTION_NAMES.every((name) =>
      checkpoints.some(
        (checkpoint) =>
          checkpoint.projection_name === name &&
          checkpoint.last_event_id !== null,
      ),
    );
    const earliest = complete
      ? [...checkpoints].sort((left, right) =>
          String(left.last_event_id).localeCompare(String(right.last_event_id)),
        )[0]
      : undefined;
    const afterId = earliest?.last_event_id ?? undefined;
    const baseSequence = earliest ? Number(earliest.last_sequence_number) : 0;

    let query = this.startupDb
      .selectFrom('events')
      .select('id')
      .orderBy('id')
      .limit(batchSize + 1);
    if (afterId) query = query.where('id', '>', afterId);
    const rows = await query.execute();
    const items = rows.slice(0, batchSize);
    const lastEventId = items.at(-1)?.id ?? afterId ?? null;
    const processedEvents = items.length;
    const pending = rows.length > batchSize;
    const rebuiltAt = new Date();

    await this.startupDb.transaction().execute(async (trx) => {
      for (const projectionName of PROJECTION_NAMES)
        await trx
          .insertInto('projection_checkpoints')
          .values({
            id: createUuidV7(),
            projection_name: projectionName,
            stream_key: 'global',
            last_event_id: lastEventId,
            last_sequence_number: String(baseSequence + processedEvents),
            updated_at: rebuiltAt,
          })
          .onConflict((conflict) =>
            conflict.columns(['projection_name', 'stream_key']).doUpdateSet({
              last_event_id: lastEventId,
              last_sequence_number: String(baseSequence + processedEvents),
              updated_at: rebuiltAt,
            }),
          )
          .execute();
    });

    return {
      status: 'completed' as const,
      projectorVersion: STARTUP_PROJECTOR_VERSION,
      processedEvents,
      processedThroughEventId: lastEventId,
      checkpointed: PROJECTION_NAMES.length,
      batches: processedEvents > 0 ? 1 : 0,
      batchSize,
      pending,
    };
  }
}

export async function drainProjectionCatchUp(
  service: Pick<BoundedStartupObservabilityService, 'rebuildProjections'>,
  batchSize: number,
  shouldStop: () => boolean = () => false,
  yieldControl: () => Promise<void> = () =>
    new Promise((resolve) => setImmediate(resolve)),
): Promise<number> {
  let batches = 0;
  while (!shouldStop()) {
    const result = await service.rebuildProjections(batchSize);
    batches += 1;
    if (!result.pending) break;
    await yieldControl();
  }
  return batches;
}

export async function assertStartupRecoveryWithinBounds(
  db: Kysely<Database>,
  now = new Date(),
  bounds: StartupRecoveryBounds = STARTUP_RECOVERY_BOUNDS,
): Promise<void> {
  const [expiredAttempts, cancellingRegions, stagedArtifacts] =
    await Promise.all([
      db
        .selectFrom('execution_attempts')
        .select('id')
        .where('status', 'in', ['leased', 'running'])
        .where('lease_expires_at', '<=', now)
        .limit(bounds.expiredAttempts + 1)
        .execute(),
      db
        .selectFrom('regions')
        .select('id')
        .where('lifecycle_status', '=', 'cancelling')
        .limit(bounds.cancellingRegions + 1)
        .execute(),
      db
        .selectFrom('artifact_staging')
        .select('id')
        .where('status', '=', 'staged')
        .limit(bounds.stagedArtifacts + 1)
        .execute(),
    ]);
  const observed = {
    expiredAttempts: expiredAttempts.length,
    cancellingRegions: cancellingRegions.length,
    stagedArtifacts: stagedArtifacts.length,
  };
  for (const [name, limit] of Object.entries(bounds))
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
  const startupObservability =
    db && !deps.startupRecoveryService
      ? new BoundedStartupObservabilityService(db)
      : undefined;
  let stopProjectionCatchUp = false;
  let projectionCatchUp: Promise<void> | undefined;

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
  const operatorCommands =
    deps.operatorCommandService ??
    (db ? new OperatorCommandService(db) : undefined);
  const operatorQueries =
    deps.operatorQueryService ??
    (db ? new OperatorQueryService(db, artifactBlobStore) : undefined);
  if (operatorCommands && operatorQueries)
    await registerOperatorRoutes(app, operatorCommands, operatorQueries);
  if (observability) await registerInspectionRoutes(app, observability);
  if (db || deps.workerProtocolService) {
    const workerProtocol =
      deps.workerProtocolService ??
      new WorkerProtocolService(db!, artifactBlobStore!, {
        leaseDurationMs: Number(process.env.WORKER_LEASE_DURATION_MS ?? 60_000),
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
        observability: startupObservability ?? observability,
        blobStore: artifactBlobStore,
      });
    app.addHook('onReady', async () => {
      if (db) await assertStartupRecoveryWithinBounds(db);
      const summary = await recovery.run({
        projectionBatchSize: 250,
        reconciliationBatchSize: 250,
      });
      app.log.info({ recovery: summary }, 'startup recovery completed');
      if (startupObservability)
        projectionCatchUp = drainProjectionCatchUp(
          startupObservability,
          250,
          () => stopProjectionCatchUp,
        )
          .then((batches) => {
            app.log.info({ batches }, 'startup projection catch-up completed');
          })
          .catch((error: unknown) => {
            app.log.error({ err: error }, 'startup projection catch-up failed');
          });
    });
  }

  if (deps.serviceAuthKeys && db) {
    const serviceAuthConfig: ServiceAuthConfig = {
      keys: deps.serviceAuthKeys,
      db: createNonceRepository(db),
    };
    registerServiceAuth(app, serviceAuthConfig);
    await registerActivityRoutes(app, new ActivitySessionService(db));
  }

  if (db)
    app.addHook('onClose', async () => {
      stopProjectionCatchUp = true;
      await projectionCatchUp;
      if (!deps.database) await db.destroy();
    });
  return app;
}
