import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import {
  createDatabase,
  createUuidV7,
} from '../packages/db/src/index.js';
import {
  CommandService,
  ExecutionCommitService,
  SchedulerService,
  StartupRecoveryService,
} from '../packages/runtime-core/src/index.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const evidenceDir =
  process.env.FACTORY_FLOOR_EVIDENCE_DIR ?? '.factory-floor/evidence/m1';
const db = createDatabase(databaseUrl);

async function seed() {
  const schemaId = createUuidV7();
  const definitionId = createUuidV7();
  const regionId = createUuidV7();
  const topologyId = createUuidV7();
  const instanceId = createUuidV7();

  await db
    .insertInto('artifact_schemas')
    .values({
      id: schemaId,
      name: 'cancellation-objective',
      version: '1',
      content_digest: 'a'.repeat(64),
      schema: { type: 'object' },
    })
    .execute();
  await db
    .insertInto('component_definitions')
    .values({
      id: definitionId,
      name: 'cancellation-worker',
      version: '1',
      content_digest: 'b'.repeat(64),
      definition: {},
    })
    .execute();
  await db
    .insertInto('port_definitions')
    .values({
      id: createUuidV7(),
      component_definition_id: definitionId,
      name: 'objective',
      direction: 'input',
      schema_id: schemaId,
      required: true,
    })
    .execute();
  await db
    .insertInto('regions')
    .values({
      id: regionId,
      name: 'cancellation-acceptance',
      lifecycle_status: 'running',
      lifecycle_epoch: 0,
    })
    .execute();
  await db
    .insertInto('topology_revisions')
    .values({
      id: topologyId,
      region_id: regionId,
      revision_number: 1,
      content_digest: 'c'.repeat(64),
      topology: {
        ingress: {
          commands: {
            'cancellation.start': {
              targets: [{ component: 'worker', port: 'objective' }],
            },
          },
        },
      },
      activated_at: new Date(),
    })
    .execute();
  await db
    .insertInto('component_instances')
    .values({
      id: instanceId,
      region_id: regionId,
      topology_revision_id: topologyId,
      component_definition_id: definitionId,
      name: 'worker',
      configuration: {},
      lifecycle_status: 'ready',
    })
    .execute();
  await db
    .updateTable('regions')
    .set({ active_topology_revision_id: topologyId })
    .where('id', '=', regionId)
    .execute();
  return regionId;
}

try {
  const regionId = await seed();
  const command = await new CommandService(db).submit({
    region: 'cancellation-acceptance',
    commandType: 'cancellation.start',
    source: { kind: 'm1-acceptance' },
    payload: { objective: 'prove cancellation fencing' },
    correlationId: `m1-cancellation-${Date.now()}`,
    idempotencyKey: createUuidV7(),
  });
  const scheduled = await new SchedulerService(db).pollForExecution({
    owner: 'm1-cancellation-worker',
    leaseDurationMs: 60_000,
  });
  if (!scheduled) throw new Error('cancellation scenario did not schedule work');

  await db
    .updateTable('regions')
    .set({ lifecycle_status: 'cancelling' })
    .where('id', '=', regionId)
    .execute();
  const recovery = await new StartupRecoveryService(db).run();

  let staleResultCode: string | null = null;
  try {
    await new ExecutionCommitService(db).commit({
      protocolVersion: '1.0',
      executionId: scheduled.executionId,
      attemptId: scheduled.attemptId,
      leaseToken: scheduled.leaseToken,
      lifecycleEpoch: 0,
      status: 'completed',
      stagedArtifacts: [],
      proposedEvents: [],
      externalActionProposals: [],
      resourceUsage: {
        cpuMilliseconds: 0,
        wallMilliseconds: 0,
        inputBytes: 0,
        outputBytes: 0,
        externalCalls: 0,
      },
    });
  } catch (error) {
    staleResultCode = (error as { code?: string }).code ?? null;
  }

  const region = await db
    .selectFrom('regions')
    .select(['id', 'lifecycle_status', 'lifecycle_epoch'])
    .where('id', '=', regionId)
    .executeTakeFirstOrThrow();
  const attempt = await db
    .selectFrom('execution_attempts')
    .select(['id', 'execution_id', 'attempt_number', 'status'])
    .where('id', '=', scheduled.attemptId)
    .executeTakeFirstOrThrow();
  const delivery = await db
    .selectFrom('deliveries')
    .select(['id', 'status', 'correlation_id'])
    .where('id', '=', scheduled.inputs[0].deliveryId)
    .executeTakeFirstOrThrow();
  const outputs = await db
    .selectFrom('execution_outputs')
    .selectAll()
    .where('execution_id', '=', scheduled.executionId)
    .execute();

  const evidence = {
    status: 'completed',
    commandId: command.commandId,
    region,
    attempt,
    delivery,
    recovery,
    staleResultCode,
    committedOutputs: outputs.length,
  };
  if (
    region.lifecycle_status !== 'cancelled' ||
    region.lifecycle_epoch !== 1 ||
    attempt.status !== 'cancelled' ||
    delivery.status !== 'cancelled' ||
    staleResultCode !== 'inactive_attempt' ||
    outputs.length !== 0
  )
    throw new Error(`cancellation acceptance failed: ${JSON.stringify(evidence)}`);

  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    join(evidenceDir, 'cancellation-evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
  globalThis.console.log(JSON.stringify(evidence, null, 2));
} finally {
  await db.destroy();
}
