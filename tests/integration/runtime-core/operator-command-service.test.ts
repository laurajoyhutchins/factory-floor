import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createUuidV7,
  migrateToLatest,
  resetDatabaseForDevelopment,
} from '../../../packages/db/src/index.js';
import {
  OperatorCommandService,
  OperatorConflictError,
  OperatorQueryService,
  PolicyDecisionService,
  RegistrationService,
  WorkerProtocolError,
  WorkerProtocolService,
} from '../../../packages/runtime-core/src/index.js';

const base = process.env.TEST_DATABASE_URL;
if (!base) throw new Error('TEST_DATABASE_URL is required');
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_operator_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);
const operator = {
  principal: { id: 'operator-test', roles: ['operator'] },
  adapter: 'integration-test',
};

async function seedRuntime(db: ReturnType<typeof createDatabase>) {
  const schemaId = createUuidV7();
  const definitionId = createUuidV7();
  const regionId = createUuidV7();
  const topologyId = createUuidV7();
  const instanceId = createUuidV7();
  await db
    .insertInto('artifact_schemas')
    .values({
      id: schemaId,
      name: 'objective',
      version: '1',
      content_digest: 'a'.repeat(64),
      schema: { type: 'object' },
    })
    .execute();
  await db
    .insertInto('component_definitions')
    .values({
      id: definitionId,
      name: 'retrieve',
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
      name: 'investigation',
      lifecycle_status: 'running',
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
            'development.task.requested': {
              targets: [{ component: 'retrieve', port: 'objective' }],
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
      name: 'retrieve',
      configuration: {},
      lifecycle_status: 'ready',
    })
    .execute();
  await db
    .updateTable('regions')
    .set({ active_topology_revision_id: topologyId })
    .where('id', '=', regionId)
    .execute();
}

async function createApproval(db: ReturnType<typeof createDatabase>) {
  await new RegistrationService(db).registerPolicy({
    apiVersion: 'factory-floor.dev/v1alpha1',
    kind: 'Policy',
    metadata: { name: 'operator.approval', version: '1.0.0' },
    spec: { outcome: 'require_approval', reason: 'Needs operator review.' },
  });
  const result = await new PolicyDecisionService(db).evaluate({
    policyName: 'operator.approval',
    policyVersion: '1.0.0',
    subjectKind: 'command',
    subjectId: createUuidV7(),
    normalizedInputs: { risk: 'review' },
  });
  return result.approvalId!;
}

function task(objective: string) {
  return {
    clientRequestId: createUuidV7(),
    repository: 'laurajoyhutchins/factory-floor',
    objective,
    acceptanceCriteria: ['The task is durably represented.'],
    authority: {
      mayCreateBranch: true,
      mayOpenDraftPullRequest: true,
      mayMerge: false as const,
    },
  };
}

describe('operator command service', () => {
  const db = createDatabase(testUrl);
  const commands = new OperatorCommandService(db);
  const queries = new OperatorQueryService(db);
  const workers = new WorkerProtocolService(db, undefined, {
    leaseDurationMs: 60_000,
    baseUrl: 'http://127.0.0.1:3000',
  });

  beforeAll(async () => {
    await admin.query(`create database ${databaseName}`);
    expect((await migrateToLatest(db)).error).toBeUndefined();
  });
  beforeEach(async () => {
    expect(
      (await resetDatabaseForDevelopment(db, 'test')).error,
    ).toBeUndefined();
    await seedRuntime(db);
  });
  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('uses the accepted command id as the run id', async () => {
    const receipt = await commands.submitDevelopmentTask(
      operator,
      task('Run identity'),
    );
    expect(receipt.runId).toBe(receipt.commandId);
    await expect(
      queries.getRunStatus(operator, receipt.runId),
    ).resolves.toMatchObject({
      status: 'queued',
      counts: { queued: 1, active: 0 },
    });
  });

  it('records and replays equivalent approval decisions', async () => {
    const approvalId = await createApproval(db);
    const request = {
      clientRequestId: createUuidV7(),
      decision: 'approve' as const,
      reason: 'Reviewed and approved.',
    };
    await expect(
      commands.decideApproval(operator, approvalId, request),
    ).resolves.toMatchObject({ disposition: 'accepted' });
    await expect(
      commands.decideApproval(operator, approvalId, request),
    ).resolves.toMatchObject({ disposition: 'replayed' });
    await expect(
      commands.decideApproval(operator, approvalId, {
        ...request,
        decision: 'reject',
      }),
    ).rejects.toBeInstanceOf(OperatorConflictError);
  });

  it('cancels only the selected run and fences its stale attempt', async () => {
    const first = await commands.submitDevelopmentTask(
      operator,
      task('Cancel this run'),
    );
    const firstClaim = await workers.claim({
      workerId: 'worker-a',
      capabilities: ['retrieve@1'],
    });
    if (!firstClaim.claimed) throw new Error('expected first claim');
    await commands.submitDevelopmentTask(operator, task('Keep this run'));
    const secondClaim = await workers.claim({
      workerId: 'worker-b',
      capabilities: ['retrieve@1'],
    });
    if (!secondClaim.claimed) throw new Error('expected second claim');

    const request = {
      clientRequestId: createUuidV7(),
      reason: 'Operator requested cancellation.',
    };
    await expect(
      commands.cancelRun(operator, first.runId, request),
    ).resolves.toMatchObject({
      disposition: 'accepted',
      cancelledExecutions: 1,
      cancelledAttempts: 1,
    });
    await expect(
      commands.cancelRun(operator, first.runId, request),
    ).resolves.toMatchObject({ disposition: 'replayed' });

    const firstAttempt = await db
      .selectFrom('execution_attempts')
      .select('status')
      .where('id', '=', firstClaim.envelope.attemptId)
      .executeTakeFirstOrThrow();
    const secondAttempt = await db
      .selectFrom('execution_attempts')
      .select('status')
      .where('id', '=', secondClaim.envelope.attemptId)
      .executeTakeFirstOrThrow();
    expect(firstAttempt.status).toBe('cancelled');
    expect(secondAttempt.status).toBe('leased');

    await expect(
      workers.submitResult({
        protocolVersion: '1.0',
        executionId: firstClaim.envelope.executionId,
        attemptId: firstClaim.envelope.attemptId,
        leaseToken: firstClaim.envelope.leaseToken,
        lifecycleEpoch: firstClaim.envelope.lifecycleEpoch,
        status: 'completed',
        stagedArtifacts: [],
        proposedEvents: [],
        externalActionProposals: [],
        resourceUsage: [],
      }),
    ).rejects.toBeInstanceOf(WorkerProtocolError);
  });
});
