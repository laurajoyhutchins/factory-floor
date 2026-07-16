import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BoundedStartupObservabilityService,
} from '../../../apps/control-plane/src/app.js';
import {
  createDatabase,
  createUuidV7,
  migrateToLatest,
  resetDatabaseForDevelopment,
} from '../../../packages/db/src/index.js';
import { PROJECTION_NAMES } from '../../../packages/runtime-core/src/index.js';

const base =
  process.env.TEST_DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_projection_bounds_${randomUUID().replaceAll('-', '')}`;
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);

describe('bounded startup projection catch-up', () => {
  const db = createDatabase(testUrl);

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
    const regionId = createUuidV7();
    await db
      .insertInto('regions')
      .values({ id: regionId, name: 'root', lifecycle_status: 'running' })
      .execute();
    for (let index = 0; index < 5; index += 1)
      await db
        .insertInto('events')
        .values({
          id: createUuidV7(),
          region_id: regionId,
          event_type: 'test.event',
          payload: { index },
          stream_key: 'test',
          sequence_number: String(index + 1),
          source_kind: 'system',
        })
        .execute();
  });

  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('advances one bounded batch and leaves explicit catch-up work pending', async () => {
    const observability = new BoundedStartupObservabilityService(db);

    const first = await observability.rebuildProjections(2);
    expect(first).toMatchObject({ processedEvents: 2, batches: 1, pending: true });
    expect(
      await db
        .selectFrom('projection_checkpoints')
        .selectAll()
        .orderBy('projection_name')
        .execute(),
    ).toHaveLength(PROJECTION_NAMES.length);

    const second = await observability.rebuildProjections(2);
    expect(second).toMatchObject({ processedEvents: 2, batches: 1, pending: true });
    expect(
      await db
        .selectFrom('projection_checkpoints')
        .select('last_sequence_number')
        .where('projection_name', '=', PROJECTION_NAMES[0])
        .where('stream_key', '=', 'global')
        .executeTakeFirstOrThrow(),
    ).toEqual({ last_sequence_number: '4' });

    const third = await observability.rebuildProjections(2);
    expect(third).toMatchObject({ processedEvents: 1, batches: 1, pending: false });
  });
});
