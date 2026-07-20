import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createUuidV7,
  migrateToLatest,
  resetDatabaseForDevelopment,
  type Json,
} from '../../../packages/db/src/index.js';
import {
  CommandService,
  ExternalActionIndeterminateError,
  ExternalActionService,
  SchedulerService,
  StartupRecoveryService,
  type ExternalActionProvider,
  type ExternalActionProviderRequest,
  type ExternalActionProviderResult,
} from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_external_action_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

class ConfirmThenLoseResponseProvider implements ExternalActionProvider {
  dispatchCalls = 0;
  reconcileCalls = 0;
  readonly idempotencyKeys: string[] = [];
  private readonly confirmed = new Map<string, string>();

  async dispatch(
    request: ExternalActionProviderRequest,
  ): Promise<ExternalActionProviderResult> {
    this.dispatchCalls++;
    this.idempotencyKeys.push(request.idempotencyKey);
    const providerOperationId = `provider-${request.actionId}`;
    this.confirmed.set(request.idempotencyKey, providerOperationId);
    throw new ExternalActionIndeterminateError('provider response was lost', {
      code: 'provider_response_lost',
      providerOperationId,
    });
  }

  async reconcile(
    request: ExternalActionProviderRequest,
  ): Promise<ExternalActionProviderResult> {
    this.reconcileCalls++;
    this.idempotencyKeys.push(request.idempotencyKey);
    const providerOperationId = this.confirmed.get(request.idempotencyKey);
    if (!providerOperationId) {
      return {
        status: 'indeterminate',
        response: { code: 'provider_operation_not_found' },
      };
    }
    return {
      status: 'acknowledged',
      response: { providerOperationId, confirmed: true },
    };
  }
}

class ProgrammingFailureProvider implements ExternalActionProvider {
  dispatchCalls = 0;
  reconcileCalls = 0;

  async dispatch(): Promise<ExternalActionProviderResult> {
    this.dispatchCalls++;
    throw new TypeError('provider adapter invariant failed');
  }

  async reconcile(): Promise<ExternalActionProviderResult> {
    this.reconcileCalls++;
    return {
      status: 'indeterminate',
      response: { code: 'unexpected_reconciliation' },
    };
  }
}

async function seedAuthorizedAction(db: ReturnType<typeof createDatabase>) {
  const schemaId = createUuidV7();
  const definitionId = createUuidV7();
  const regionId = createUuidV7();
  const topologyId = createUuidV7();
  const instanceId = createUuidV7();
  const capabilityId = createUuidV7();
  const grantId = createUuidV7();

  await db
    .insertInto('artifact_schemas')
    .values({
      id: schemaId,
      name: 'external-action-request',
      version: '1',
      content_digest: 'a'.repeat(64),
      schema: { type: 'object' },
    })
    .execute();
  await db
    .insertInto('component_definitions')
    .values({
      id: definitionId,
      name: 'external-action-producer',
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
      name: 'in',
      direction: 'input',
      schema_id: schemaId,
      required: true,
    })
    .execute();
  await db
    .insertInto('capabilities')
    .values({
      id: capabilityId,
      name: 'external-action-provider',
      version: '1',
      capability_type: 'test.external-action',
      content_digest: 'c'.repeat(64),
      configuration: {},
    })
    .execute();
  await db
    .insertInto('capability_grants')
    .values({
      id: grantId,
      capability_id: capabilityId,
      grantee_component_definition_id: definitionId,
      status: 'active',
    })
    .execute();
  await db
    .insertInto('regions')
    .values({
      id: regionId,
      name: 'external-action-region',
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
      content_digest: 'd'.repeat(64),
      topology: {
        ingress: {
          commands: {
            start: {
              targets: [{ component: 'external-action-producer', port: 'in' }],
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
      name: 'external-action-producer',
      configuration: {},
      lifecycle_status: 'ready',
    })
    .execute();
  await db
    .updateTable('regions')
    .set({ active_topology_revision_id: topologyId })
    .where('id', '=', regionId)
    .execute();

  await new CommandService(db).submit({
    region: '/external-action-region',
    commandType: 'start',
    source: { kind: 'external-action-recovery-test' },
    payload: { request: true },
    correlationId: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  const scheduled = await new SchedulerService(db).pollForExecution({
    owner: 'external-action-recovery-worker',
    leaseDurationMs: 60_000,
  });
  if (!scheduled) throw new Error('expected scheduled execution');

  const requestBody = JSON.stringify({ send: 'once' });
  const artifactId = createUuidV7();
  await db
    .insertInto('artifacts')
    .values({
      id: artifactId,
      digest_algorithm: 'sha256',
      digest: createHash('sha256').update(requestBody).digest('hex'),
      size_bytes: String(Buffer.byteLength(requestBody)),
      schema_id: schemaId,
      state: 'committed',
      media_type: 'application/json',
      committed_locator: `test:${artifactId}`,
      provenance: { kind: 'external-action-recovery-test' },
      tombstoned_at: null,
    })
    .execute();

  const actionId = createUuidV7();
  const policyDecisionId = createUuidV7();
  await db
    .insertInto('policy_decisions')
    .values({
      id: policyDecisionId,
      policy_id: null,
      policy_name: 'external-action-test-policy',
      policy_version: '1',
      evaluator_version: 'test',
      subject_kind: 'external_action',
      subject_id: actionId,
      input_artifact_id: artifactId,
      normalized_inputs: {},
      outcome: 'allow',
      reason: null,
      modifications: [],
    })
    .execute();
  const idempotencyKey = `external-action-${randomUUID()}`;
  await db
    .insertInto('external_actions')
    .values({
      id: actionId,
      execution_id: scheduled.executionId,
      attempt_id: scheduled.attemptId,
      proposal_id: createUuidV7(),
      capability_grant_id: grantId,
      outbound_request_artifact_id: artifactId,
      policy_decision_id: policyDecisionId,
      approval_id: null,
      action_type: 'test.external-action',
      risk: 'medium',
      status: 'authorized',
      idempotency_key: idempotencyKey,
    })
    .execute();

  return {
    actionId,
    regionId,
    idempotencyKey,
    scheduled,
  };
}

function response(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

describe('external action dispatch and startup recovery', () => {
  const db = createDatabase(testUrl);
  let now = new Date();

  beforeAll(async () => {
    await admin.query(`create database ${databaseName}`);
    expect((await migrateToLatest(db)).error).toBeUndefined();
  });

  beforeEach(async () => {
    expect(
      (await resetDatabaseForDevelopment(db, 'test')).error,
    ).toBeUndefined();
    now = new Date(Date.now() + 60_000);
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('reconciles a confirmed side effect after a lost response without redispatch', async () => {
    const seeded = await seedAuthorizedAction(db);
    const provider = new ConfirmThenLoseResponseProvider();
    const dispatch = new ExternalActionService(db, provider, () => now);

    await expect(dispatch.dispatch(seeded.actionId)).resolves.toEqual({
      disposition: 'dispatched',
      status: 'indeterminate',
    });
    expect(provider.dispatchCalls).toBe(1);
    expect(provider.reconcileCalls).toBe(0);
    await expect(
      db
        .selectFrom('external_actions')
        .select(['status', 'idempotency_key'])
        .where('id', '=', seeded.actionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: 'indeterminate',
      idempotency_key: seeded.idempotencyKey,
    });
    await expect(
      db
        .selectFrom('external_action_attempts')
        .select(['attempt_number', 'status', 'response'])
        .where('external_action_id', '=', seeded.actionId)
        .execute(),
    ).resolves.toEqual([
      {
        attempt_number: 1,
        status: 'indeterminate',
        response: response({
          code: 'provider_response_lost',
          providerOperationId: `provider-${seeded.actionId}`,
        }),
      },
    ]);

    const first = await new StartupRecoveryService(db, {
      clock: () => now,
      externalActions: new ExternalActionService(db, provider, () => now),
    }).run({ now });
    const second = await new StartupRecoveryService(db, {
      clock: () => now,
      externalActions: new ExternalActionService(db, provider, () => now),
    }).run({ now });

    expect(first.externalActionReconciliation).toEqual({
      scanned: 1,
      reconciled: 1,
      failed: 0,
      indeterminate: 0,
    });
    expect(second.externalActionReconciliation).toEqual({
      scanned: 0,
      reconciled: 0,
      failed: 0,
      indeterminate: 0,
    });
    expect(provider.dispatchCalls).toBe(1);
    expect(provider.reconcileCalls).toBe(1);
    expect(provider.idempotencyKeys).toEqual([
      seeded.idempotencyKey,
      seeded.idempotencyKey,
    ]);
    await expect(
      db
        .selectFrom('external_actions')
        .select('status')
        .where('id', '=', seeded.actionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'reconciled' });
    await expect(
      db
        .selectFrom('external_action_attempts')
        .select(['attempt_number', 'status', 'response'])
        .where('external_action_id', '=', seeded.actionId)
        .execute(),
    ).resolves.toEqual([
      {
        attempt_number: 1,
        status: 'acknowledged',
        response: response({
          providerOperationId: `provider-${seeded.actionId}`,
          confirmed: true,
        }),
      },
    ]);
    const recoveryEvents = await db
      .selectFrom('events')
      .select('payload')
      .where('event_type', '=', 'runtime.recovery.completed')
      .orderBy('created_at')
      .execute();
    expect(recoveryEvents).toHaveLength(2);
    expect(recoveryEvents[0]?.payload).toMatchObject({
      externalActionReconciliation: first.externalActionReconciliation,
    });
  });

  it('cancels stale lifecycle authority before calling the provider', async () => {
    const seeded = await seedAuthorizedAction(db);
    await db
      .updateTable('regions')
      .set({ lifecycle_epoch: 1 })
      .where('id', '=', seeded.regionId)
      .execute();
    const provider = new ConfirmThenLoseResponseProvider();

    await expect(
      new ExternalActionService(db, provider, () => now).dispatch(seeded.actionId),
    ).resolves.toEqual({ disposition: 'cancelled' });
    expect(provider.dispatchCalls).toBe(0);
    await expect(
      db
        .selectFrom('external_actions')
        .select('status')
        .where('id', '=', seeded.actionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'cancelled' });
    await expect(
      db
        .selectFrom('external_action_attempts')
        .selectAll()
        .where('external_action_id', '=', seeded.actionId)
        .execute(),
    ).resolves.toHaveLength(0);
  });

  it('leaves an unexpected provider failure visibly dispatching', async () => {
    const seeded = await seedAuthorizedAction(db);
    const provider = new ProgrammingFailureProvider();

    await expect(
      new ExternalActionService(db, provider, () => now).dispatch(seeded.actionId),
    ).rejects.toThrow('provider adapter invariant failed');
    expect(provider.dispatchCalls).toBe(1);
    expect(provider.reconcileCalls).toBe(0);
    await expect(
      db
        .selectFrom('external_actions')
        .select('status')
        .where('id', '=', seeded.actionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'dispatching' });
    await expect(
      db
        .selectFrom('external_action_attempts')
        .select(['status', 'completed_at', 'response'])
        .where('external_action_id', '=', seeded.actionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: 'dispatching',
      completed_at: null,
      response: null,
    });
  });
});
