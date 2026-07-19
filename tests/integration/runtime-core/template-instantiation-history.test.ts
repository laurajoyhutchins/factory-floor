import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  DefinitionRepository,
  migrateToLatest,
  resetDatabaseForDevelopment,
  TemplateInstantiationRepository,
  TopologyRepository,
  type RuntimeDb,
} from '../../../packages/db/src/index.js';
import {
  RegistrationService,
  TemplateInstantiationService,
} from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_template_history_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

const requestA = '019bb22e-58b0-7d87-8000-000000000201';
const requestB = '019bb22e-58b0-7d87-8000-000000000202';

const templateDocument = {
  apiVersion: 'factoryfloor.dev/v1alpha1',
  kind: 'Template',
  metadata: { name: 'durable-empty', version: '1' },
  spec: {
    initialTopology: { instances: [], connections: [] },
  },
};

class RollbackProbeRepository extends TemplateInstantiationRepository {
  override async create(
    db: RuntimeDb,
    input: Parameters<TemplateInstantiationRepository['create']>[1],
  ) {
    await super.create(db, input);
    throw new Error('forced failure after durable history insert');
  }
}

describe('durable template instantiation history in PostgreSQL', () => {
  const db = createDatabase(testUrl);
  const registrations = new RegistrationService(db);
  const topology = new TopologyRepository();
  let regionId: string;

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
    await registrations.registerTemplate(templateDocument);
    regionId = (await topology.createRegion(db, 'durable-history', null)).id;
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('persists stable request identities without duplicating effective topology', async () => {
    const service = new TemplateInstantiationService(db);
    const source = { kind: 'internal', operation: 'integration-test' };

    const first = await service.instantiate({
      requestId: requestA,
      targetRegionId: regionId,
      template: 'durable-empty@1',
      source,
    });
    const retry = await service.instantiate({
      requestId: requestA,
      targetRegionId: regionId,
      template: 'durable-empty@1',
      source,
    });
    const second = await service.instantiate({
      requestId: requestB,
      targetRegionId: regionId,
      template: 'durable-empty@1',
      source,
    });

    expect(first.disposition).toBe('created');
    expect(retry).toMatchObject({
      disposition: 'existing',
      instantiationId: first.instantiationId,
      digest: first.digest,
    });
    expect(second).toMatchObject({
      disposition: 'existing',
      digest: first.digest,
    });
    expect(second.instantiationId).not.toBe(first.instantiationId);

    const records = await db
      .selectFrom('template_instantiations')
      .selectAll()
      .orderBy('created_at')
      .execute();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.request_id)).toEqual([
      requestA,
      requestB,
    ]);
    expect(records.map((record) => record.initial_disposition)).toEqual([
      'created',
      'existing',
    ]);
    expect(
      await db.selectFrom('topology_revisions').selectAll().execute(),
    ).toHaveLength(1);

    await expect(
      service.instantiate({
        requestId: requestA,
        targetRegionId: regionId,
        template: 'durable-empty@1',
        source: { kind: 'internal', operation: 'changed' },
      }),
    ).rejects.toMatchObject({ code: 'template_instantiation_conflict' });
    expect(
      await db.selectFrom('template_instantiations').selectAll().execute(),
    ).toHaveLength(2);
  });

  it('rolls back topology activation and durable history together', async () => {
    const service = new TemplateInstantiationService(
      db,
      new DefinitionRepository(),
      topology,
      new RollbackProbeRepository(),
    );

    await expect(
      service.instantiate({
        requestId: requestA,
        targetRegionId: regionId,
        template: 'durable-empty@1',
        source: { kind: 'internal', operation: 'rollback-probe' },
      }),
    ).rejects.toThrow('forced failure after durable history insert');

    expect(
      await db.selectFrom('template_instantiations').selectAll().execute(),
    ).toEqual([]);
    expect(
      await db.selectFrom('topology_revisions').selectAll().execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom('regions')
        .select('active_topology_revision_id')
        .where('id', '=', regionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ active_topology_revision_id: null });
  });
});
