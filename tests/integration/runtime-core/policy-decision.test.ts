import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createUuidV7,
  migrateToLatest,
} from '../../../packages/db/src/index.js';
import {
  PolicyDecisionService,
  RegistrationService,
} from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_policy_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

describe('durable policy decisions', () => {
  const db = createDatabase(testUrl);

  beforeAll(async () => {
    await admin.query(`create database ${databaseName}`);
    expect((await migrateToLatest(db)).error).toBeUndefined();
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('records a deterministic require-approval decision and approval request', async () => {
    const registration = await new RegistrationService(db).registerPolicy({
      apiVersion: 'factory-floor.dev/v1alpha1',
      kind: 'Policy',
      metadata: { name: 'm1.acceptance', version: '1.0.0' },
      spec: {
        outcome: 'require_approval',
        reason: 'Operator approval is required for the acceptance subject.',
      },
    });
    expect(registration.disposition).toBe('created');

    const subjectId = createUuidV7();
    const result = await new PolicyDecisionService(db).evaluate({
      policyName: 'm1.acceptance',
      policyVersion: '1.0.0',
      subjectKind: 'command',
      subjectId,
      normalizedInputs: { purpose: 'm1 acceptance evidence' },
    });

    expect(result).toMatchObject({
      outcome: 'require_approval',
      modifications: [],
    });
    expect(result.approvalId).not.toBeNull();

    await expect(
      db
        .selectFrom('policy_decisions')
        .selectAll()
        .where('id', '=', result.decisionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      policy_id: registration.entity.id,
      policy_name: 'm1.acceptance',
      policy_version: '1.0.0',
      evaluator_version: 'factory-floor-policy-evaluator/1.0.0',
      subject_kind: 'command',
      subject_id: subjectId,
      normalized_inputs: { purpose: 'm1 acceptance evidence' },
      outcome: 'require_approval',
      reason: 'Operator approval is required for the acceptance subject.',
      modifications: [],
    });
    await expect(
      db
        .selectFrom('approvals')
        .selectAll()
        .where('policy_decision_id', '=', result.decisionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      id: result.approvalId,
      status: 'requested',
    });
  });
});
