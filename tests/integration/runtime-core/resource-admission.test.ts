import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createUuidV7,
  migrateToLatest,
  resetDatabaseForDevelopment,
} from '../../../packages/db/src/index.js';
import { ResourceAdmissionService } from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_resource_admission_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);
const raw = new pg.Pool({
  connectionString: testUrl,
  connectionTimeoutMillis: 10_000,
});

describe('resource admission persistence', () => {
  const db = createDatabase(testUrl);
  const admission = new ResourceAdmissionService(db);
  let rootRegionId: string;
  let childRegionId: string;

  beforeAll(async () => {
    try {
      await admin.query(`create database ${databaseName}`);
      expect((await migrateToLatest(db)).error).toBeUndefined();
    } catch (error) {
      throw new Error(
        `PostgreSQL integration database is required at TEST_DATABASE_URL=${base}. Cause: ${String(error)}`,
      );
    }
  });

  beforeEach(async () => {
    expect(
      (await resetDatabaseForDevelopment(db, 'test')).error,
    ).toBeUndefined();
    rootRegionId = createUuidV7();
    childRegionId = createUuidV7();
    await db
      .insertInto('regions')
      .values({ id: rootRegionId, name: 'root' })
      .execute();
    await db
      .insertInto('regions')
      .values({
        id: childRegionId,
        name: 'child',
        parent_region_id: rootRegionId,
      })
      .execute();
  });

  afterAll(async () => {
    await db.destroy();
    await raw.end();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('relinks an unchanged child limit when a matching parent budget is introduced', async () => {
    await admission.configureRegionBudgets({
      regionId: childRegionId,
      parentRegionId: rootRegionId,
      budgets: { maximumConcurrentExecutions: 2 },
      source: { kind: 'integration-test', revision: 1 },
    });
    await admission.configureRegionBudgets({
      regionId: rootRegionId,
      budgets: { maximumConcurrentExecutions: 3 },
      source: { kind: 'integration-test', revision: 2 },
    });
    await admission.configureRegionBudgets({
      regionId: childRegionId,
      parentRegionId: rootRegionId,
      budgets: { maximumConcurrentExecutions: 2 },
      source: { kind: 'integration-test', revision: 2 },
    });

    const childBudget = await raw.query<{
      parent_scope_id: string | null;
      active_count: string;
    }>(
      `select
         parent.scope_id as parent_scope_id,
         count(*) over ()::text as active_count
       from resource_budgets child
       left join resource_budgets parent on parent.id = child.parent_budget_id
       where child.scope_kind = 'region'
         and child.scope_id = $1
         and child.resource_type = 'concurrent_executions'
         and child.retired_at is null`,
      [childRegionId],
    );

    expect(childBudget.rows).toEqual([
      { parent_scope_id: rootRegionId, active_count: '1' },
    ]);
  });

  it('rejects a child limit that exceeds its active parent limit', async () => {
    await admission.configureRegionBudgets({
      regionId: rootRegionId,
      budgets: { maximumConcurrentExecutions: 3 },
      source: { kind: 'integration-test' },
    });

    await expect(
      admission.configureRegionBudgets({
        regionId: childRegionId,
        parentRegionId: rootRegionId,
        budgets: { maximumConcurrentExecutions: 4 },
        source: { kind: 'integration-test' },
      }),
    ).rejects.toThrow('cannot exceed parent limit');
  });
});
