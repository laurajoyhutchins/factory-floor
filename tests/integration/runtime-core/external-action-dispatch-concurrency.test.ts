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
  ExternalActionService,
  PolicyDecisionService,
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
const databaseName = `ff_external_action_concurrency_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

class BlockingAcknowledgementProvider implements ExternalActionProvider {
  dispatchCalls = 0;
  reconcileCalls = 0;
  private markStarted!: () => void;
  private release!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  completeDispatch() {
    this.release();
  }

  async dispatch(
    request: ExternalActionProviderRequest,
  ): Promise<ExternalActionProviderResult> {
    this.dispatchCalls++;
    this.markStarted();
    await this.released;
    return {
      status: 'acknowledged',
      response: { providerOperationId: `provider-${request.actionId}` },
    };
  }

  async reconcile(): Promise<ExternalActionProviderResult> {
    this.reconcileCalls++;
    throw new Error('dispatch callers must not reconcile an in-flight action');
  }
}

async function seedAuthorizedAction(db: ReturnType<typeof createDatabase>) {
  const schemaId = createUuidV7();
  const definitionId = createUuidV7();
  const regionId = createUuidV7();
  const topologyId = createUuidV7();
  const instanceId = createUuidV7();
  const commandId = createUuidV7();
  const deliveryId = createUuidV7();
  const executionId = createUuidV7();
  const attemptId = createUuidV7();
  const artifactId = createUuidV7();
  const capabilityId = createUuidV7();
  const grantId = createUuidV7();
  const actionId = createUuidV7();

  await db
    .insertInto('artifact_schemas')
    .values({
      id: schemaId,
      name: 'external-action-concurrency-request',
      version: '1',
      content_digest: 'a'.repeat(64),
      schema: { type: 'object' },
    })
    .execute();
  await db
    .insertInto('component_definitions')
    .values({
      id: definitionId,
      name: 'external-action-concurrency-producer',
      version: '1',
      content_digest: 'b'.repeat(64),
      definition: {},
    })
    .execute();
  await db
    .insertInto('regions')
    .values({
      id: regionId,
      name: 'external-action-concurrency-region',
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
      topology: {},
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
      name: 'external-action-concurrency-producer',
      configuration: {},
      lifecycle_status: 'ready',
    })
    .execute();
  await db
    .updateTable('regions')
    .set({ active_topology_revision_id: topologyId })
    .where('id', '=', regionId)
    .execute();
  await db
    .insertInto('commands')
    .values({
      id: commandId,
      region_id: regionId,
      command_type: 'external-action-concurrency.start',
      payload: {},
      status: 'accepted',
      correlation_id: randomUUID(),
      idempotency_key: randomUUID(),
    })
    .execute();
  await db
    .insertInto('deliveries')
    .values({
      id: deliveryId,
      region_id: regionId,
      topology_revision_id: topologyId,
      target_component_instance_id: instanceId,
      target_port_name: 'in',
      source_command_id: commandId,
      source_event_id: null,
      status: 'ready',
    })
    .execute();
  await db
    .insertInto('executions')
    .values({
      id: executionId,
      delivery_id: deliveryId,
      region_id: regionId,
      component_instance_id: instanceId,
      topology_revision_id: topologyId,
      lifecycle_epoch: 0,
      status: 'running',
    })
    .execute();
  await db
    .insertInto('execution_attempts')
    .values({
      id: attemptId,
      execution_id: executionId,
      attempt_number: 1,
      status: 'pending',
    })
    .execute();
  await db
    .insertInto('artifacts')
    .values({
      id: artifactId,
      digest_algorithm: 'sha256',
      digest: 'd'.repeat(64),
      size_bytes: '1',
      schema_id: schemaId,
      state: 'committed',
      media_type: 'application/json',
      committed_locator: `test:${artifactId}`,
      provenance: { kind: 'external-action-concurrency-test' },
      tombstoned_at: null,
    })
    .execute();
  await db
    .insertInto('capabilities')
    .values({
      id: capabilityId,
      name: 'external-action-concurrency-provider',
      version: '1',
      capability_type: 'test.external-action',
      content_digest: 'e'.repeat(64),
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
    .insertInto('policies')
    .values({
      id: createUuidV7(),
      name: 'external-action-concurrency-policy',
      version: '1',
      content_digest: 'f'.repeat(64),
      policy: {
        spec: {
          outcome: 'allow',
          reason: 'Allow the deterministic concurrency regression.',
        },
      },
    })
    .execute();
  const policyDecision = await new PolicyDecisionService(db).evaluate({
    policyName: 'external-action-concurrency-policy',
    policyVersion: '1',
    subjectKind: 'external_action',
    subjectId: actionId,
    inputArtifactId: artifactId,
    normalizedInputs: {},
  });
  await db
    .insertInto('external_actions')
    .values({
      id: actionId,
      execution_id: executionId,
      attempt_id: attemptId,
      proposal_id: createUuidV7(),
      capability_grant_id: grantId,
      outbound_request_artifact_id: artifactId,
      policy_decision_id: policyDecision.decisionId,
      approval_id: null,
      action_type: 'test.external-action',
      risk: 'medium',
      status: 'authorized',
      idempotency_key: `external-action-${randomUUID()}`,
    })
    .execute();

  return actionId;
}

describe('external action dispatch concurrency', () => {
  const db = createDatabase(testUrl);

  beforeAll(async () => {
    await admin.query(`create database ${databaseName}`);
    expect((await migrateToLatest(db)).error).toBeUndefined();
  });

  beforeEach(async () => {
    expect(
      (await resetDatabaseForDevelopment(db, 'test')).error,
    ).toBeUndefined();
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('does not reconcile while the first provider dispatch is still in flight', async () => {
    const actionId = await seedAuthorizedAction(db);
    const provider = new BlockingAcknowledgementProvider();
    const service = new ExternalActionService(db, provider);

    const firstDispatch = service.dispatch(actionId);
    await provider.started;

    await expect(service.dispatch(actionId)).resolves.toEqual({
      disposition: 'uncertain',
      status: 'dispatching',
    });
    expect(provider.dispatchCalls).toBe(1);
    expect(provider.reconcileCalls).toBe(0);

    provider.completeDispatch();
    await expect(firstDispatch).resolves.toEqual({
      disposition: 'dispatched',
      status: 'acknowledged',
    });
    await expect(
      db
        .selectFrom('external_action_attempts')
        .select(['attempt_number', 'status'])
        .where('external_action_id', '=', actionId)
        .execute(),
    ).resolves.toEqual([{ attempt_number: 1, status: 'acknowledged' }]);
  });
});
