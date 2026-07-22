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
  OperatorQueryService,
  PolicyDecisionService,
  WorkerProtocolService,
} from '../../../packages/runtime-core/src/index.js';

const base = process.env.TEST_DATABASE_URL;
if (!base) throw new Error('TEST_DATABASE_URL is required');
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_run_details_${randomUUID().replaceAll('-', '')}`;
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
  return { schemaId, definitionId, regionId };
}

function task(objective: string) {
  return {
    clientRequestId: createUuidV7(),
    repository: 'laurajoyhutchins/factory-floor',
    objective,
    acceptanceCriteria: ['Run details remain isolated by correlation.'],
  };
}

type ClaimedRun = {
  runId: string;
  executionId: string;
  attemptId: string;
  deliveryId: string;
};

async function seedRunDetails(
  db: ReturnType<typeof createDatabase>,
  run: ClaimedRun,
  schemaId: string,
  regionId: string,
  capabilityGrantId: string,
  ordinal: number,
) {
  const sourceArtifactId = createUuidV7();
  const resultArtifactId = createUuidV7();
  const actionId = createUuidV7();
  const derivationId = createUuidV7();
  const resourceId = createUuidV7();
  const policyName = `approval-policy-${ordinal}`;
  const policyReason = `Approval required for run ${ordinal}.`;

  await db
    .insertInto('policies')
    .values({
      id: createUuidV7(),
      name: policyName,
      version: '1',
      content_digest: (ordinal + 200).toString(16).padStart(64, '0'),
      retired_at: null,
      policy: {
        spec: {
          outcome: 'require_approval',
          reason: policyReason,
          modifications: [],
        },
      },
    })
    .execute();

  const decision = await new PolicyDecisionService(
    db,
    'test-evaluator/1',
  ).evaluate({
    policyName,
    policyVersion: '1',
    subjectKind: 'external_action',
    subjectId: actionId,
    inputArtifactId: null,
    normalizedInputs: { ordinal },
  });
  if (!decision.approvalId)
    throw new Error('expected require_approval policy to create an approval');
  const policyDecisionId = decision.decisionId;
  const approvalId = decision.approvalId;

  await db
    .insertInto('artifacts')
    .values([
      {
        id: sourceArtifactId,
        digest_algorithm: 'sha256',
        digest: ordinal.toString(16).padStart(64, '0'),
        size_bytes: '4',
        schema_id: schemaId,
        state: 'committed',
        media_type: 'application/json',
        committed_locator: `memory://source-${ordinal}`,
        provenance: { runId: run.runId, role: 'source' },
        tombstoned_at: null,
      },
      {
        id: resultArtifactId,
        digest_algorithm: 'sha256',
        digest: (ordinal + 100).toString(16).padStart(64, '0'),
        size_bytes: '8',
        schema_id: schemaId,
        state: 'committed',
        media_type: 'application/json',
        committed_locator: `memory://result-${ordinal}`,
        provenance: { runId: run.runId, role: 'result' },
        tombstoned_at: null,
      },
    ])
    .execute();
  await db
    .insertInto('execution_inputs')
    .values({
      id: createUuidV7(),
      execution_id: run.executionId,
      port_name: 'objective',
      artifact_id: sourceArtifactId,
      delivery_id: run.deliveryId,
      payload: null,
    })
    .execute();
  await db
    .insertInto('execution_outputs')
    .values({
      id: createUuidV7(),
      execution_id: run.executionId,
      attempt_id: run.attemptId,
      port_name: 'result',
      artifact_id: resultArtifactId,
      published_event_id: null,
    })
    .execute();
  await db
    .insertInto('artifact_derivations')
    .values({
      id: derivationId,
      artifact_id: resultArtifactId,
      source_artifact_id: sourceArtifactId,
      execution_id: run.executionId,
      attempt_id: run.attemptId,
      derivation_type: 'test-transform',
    })
    .execute();
  await db
    .insertInto('external_actions')
    .values({
      id: actionId,
      execution_id: run.executionId,
      attempt_id: run.attemptId,
      proposal_id: `proposal-${ordinal}`,
      capability_grant_id: capabilityGrantId,
      outbound_request_artifact_id: resultArtifactId,
      policy_decision_id: policyDecisionId,
      approval_id: approvalId,
      action_type: `test.action.${ordinal}`,
      risk: 'medium',
      status: 'awaiting_approval',
      idempotency_key: `run-details-${ordinal}`,
    })
    .execute();
  await db
    .insertInto('resource_ledger')
    .values({
      id: resourceId,
      region_id: regionId,
      execution_id: run.executionId,
      attempt_id: run.attemptId,
      external_action_id: actionId,
      resource_type: 'tokens',
      quantity: String(ordinal * 10),
      unit: 'token',
      attributes: { budgetLimit: '1000', ordinal },
    })
    .execute();

  return {
    policyDecisionId,
    approvalId,
    sourceArtifactId,
    resultArtifactId,
    actionId,
    derivationId,
    resourceId,
  };
}

describe('run details query service', () => {
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
  });
  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('returns bounded details for one run without leaking a concurrent run', async () => {
    const { schemaId, definitionId, regionId } = await seedRuntime(db);
    const capabilityId = createUuidV7();
    const capabilityGrantId = createUuidV7();
    await db
      .insertInto('capabilities')
      .values({
        id: capabilityId,
        name: 'test-action',
        version: '1',
        content_digest: 'd'.repeat(64),
        retired_at: null,
        capability_type: 'external_action',
        configuration: {},
      })
      .execute();
    await db
      .insertInto('capability_grants')
      .values({
        id: capabilityGrantId,
        capability_id: capabilityId,
        grantee_component_definition_id: definitionId,
        status: 'active',
        granted_at: new Date(),
        revoked_at: null,
      })
      .execute();

    const firstReceipt = await commands.submitDevelopmentTask(
      operator,
      task('First isolated run'),
    );
    const firstClaim = await workers.claim({
      workerId: 'worker-a',
      capabilities: ['retrieve@1'],
    });
    if (!firstClaim.claimed) throw new Error('expected first claim');
    const firstDeliveryId = firstClaim.envelope.inputs[0]?.deliveryId;
    if (!firstDeliveryId) throw new Error('expected first delivery');
    const firstRun = {
      runId: firstReceipt.runId,
      executionId: firstClaim.envelope.executionId,
      attemptId: firstClaim.envelope.attemptId,
      deliveryId: firstDeliveryId,
    };

    const secondReceipt = await commands.submitDevelopmentTask(
      operator,
      task('Second isolated run'),
    );
    const secondClaim = await workers.claim({
      workerId: 'worker-b',
      capabilities: ['retrieve@1'],
    });
    if (!secondClaim.claimed) throw new Error('expected second claim');
    const secondDeliveryId = secondClaim.envelope.inputs[0]?.deliveryId;
    if (!secondDeliveryId) throw new Error('expected second delivery');
    const secondRun = {
      runId: secondReceipt.runId,
      executionId: secondClaim.envelope.executionId,
      attemptId: secondClaim.envelope.attemptId,
      deliveryId: secondDeliveryId,
    };

    const first = await seedRunDetails(
      db,
      firstRun,
      schemaId,
      regionId,
      capabilityGrantId,
      1,
    );
    const second = await seedRunDetails(
      db,
      secondRun,
      schemaId,
      regionId,
      capabilityGrantId,
      2,
    );
    await db
      .insertInto('projection_checkpoints')
      .values({
        id: createUuidV7(),
        projection_name: 'run_status',
        stream_key: 'global',
        last_event_id: null,
        last_sequence_number: '0',
        updated_at: new Date(Date.now() - 120_000),
      })
      .execute();

    const details = await queries.getRunDetails(operator, firstRun.runId);

    expect(details.runId).toBe(firstRun.runId);
    expect(details.approvals.map((item) => item.id)).toEqual([
      first.approvalId,
    ]);
    expect(details.policyDecisions.map((item) => item.id)).toEqual([
      first.policyDecisionId,
    ]);
    expect(details.resources.map((item) => item.id)).toEqual([
      first.resourceId,
    ]);
    expect(details.derivations.map((item) => item.id)).toEqual([
      first.derivationId,
    ]);
    expect(details.projectionFreshness.scope).toBe('control_plane_global');
    expect(details.projectionFreshness.items).toHaveLength(1);
    expect(details.projectionFreshness.items[0]).toMatchObject({
      projectionName: 'run_status',
      stale: true,
    });
    expect(details.projectionFreshness.items[0]).not.toHaveProperty('id');
    expect(details.projectionFreshness.items[0]).not.toHaveProperty(
      'streamKey',
    );
    expect(details.projectionFreshness.items[0]).not.toHaveProperty(
      'lastEventId',
    );
    expect(details.projectionFreshness.items[0]).not.toHaveProperty(
      'lastSequenceNumber',
    );

    expect(JSON.stringify(details)).not.toContain(second.approvalId);
    expect(JSON.stringify(details)).not.toContain(second.policyDecisionId);
    expect(JSON.stringify(details)).not.toContain(second.resourceId);
    expect(JSON.stringify(details)).not.toContain(second.derivationId);
    expect(JSON.stringify(details)).not.toContain(secondRun.runId);
  });
});
