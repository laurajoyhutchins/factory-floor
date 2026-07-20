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
  WorkerProtocolService,
} from '../../../packages/runtime-core/src/index.js';

const base = process.env.TEST_DATABASE_URL;
if (!base) throw new Error('TEST_DATABASE_URL is required');
const admin = new pg.Pool({
  connectionString: base,
  connectionTimeoutMillis: 10_000,
});
const databaseName = `ff_operator_query_${randomUUID().replaceAll('-', '')}`;
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
  return { schemaId, regionId };
}

function task(objective: string) {
  return {
    clientRequestId: createUuidV7(),
    repository: 'laurajoyhutchins/factory-floor',
    objective,
    acceptanceCriteria: ['The task is durably represented.'],
  };
}

describe('operator query service', () => {
  const db = createDatabase(testUrl);
  const commands = new OperatorCommandService(db);
  const queries = new OperatorQueryService(db);
  const workers = new WorkerProtocolService(db, undefined, {
    leaseDurationMs: 60_000,
    baseUrl: 'http://127.0.0.1:3000',
  });
  let schemaId: string;
  let regionId: string;

  beforeAll(async () => {
    await admin.query(`create database ${databaseName}`);
    expect((await migrateToLatest(db)).error).toBeUndefined();
  });
  beforeEach(async () => {
    expect(
      (await resetDatabaseForDevelopment(db, 'test')).error,
    ).toBeUndefined();
    ({ schemaId, regionId } = await seedRuntime(db));
  });
  afterAll(async () => {
    await db.destroy();
    await admin
      .query(`drop database if exists ${databaseName}`)
      .catch(() => undefined);
    await admin.end();
  });

  it('derives active counts from durable run state', async () => {
    const receipt = await commands.submitDevelopmentTask(
      operator,
      task('Active status'),
    );
    const claimed = await workers.claim({
      workerId: 'worker-a',
      capabilities: ['retrieve@1'],
    });
    if (!claimed.claimed) throw new Error('expected claim');
    await expect(
      queries.getRunStatus(operator, receipt.runId),
    ).resolves.toMatchObject({
      status: 'running',
      counts: { queued: 0, active: 1, completed: 0, failed: 0, cancelled: 0 },
    });
  });

  it('returns topology records only from the selected run correlation', async () => {
    const first = await commands.submitDevelopmentTask(
      operator,
      task('First topology'),
    );
    const firstClaim = await workers.claim({
      workerId: 'worker-a',
      capabilities: ['retrieve@1'],
    });
    if (!firstClaim.claimed) throw new Error('expected first claim');
    const firstDeliveryId = firstClaim.envelope.inputs[0]?.deliveryId;
    if (!firstDeliveryId) throw new Error('expected first delivery');
    const second = await commands.submitDevelopmentTask(
      operator,
      task('Second topology'),
    );
    const secondClaim = await workers.claim({
      workerId: 'worker-b',
      capabilities: ['retrieve@1'],
    });
    if (!secondClaim.claimed) throw new Error('expected second claim');
    const secondDeliveryId = secondClaim.envelope.inputs[0]?.deliveryId;
    if (!secondDeliveryId) throw new Error('expected second delivery');

    const topology = await queries.getRunTopology(operator, first.runId);
    expect(topology.run.id).toBe(first.runId);
    expect(topology.regions.map((region) => region.id)).toContain(regionId);
    expect(topology.deliveries.map((delivery) => delivery.id)).toContain(
      firstDeliveryId,
    );
    expect(topology.deliveries.map((delivery) => delivery.id)).not.toContain(
      secondDeliveryId,
    );
    expect(topology.executions.map((execution) => execution.id)).toContain(
      firstClaim.envelope.executionId,
    );
    expect(topology.executions.map((execution) => execution.id)).not.toContain(
      secondClaim.envelope.executionId,
    );
    expect(topology.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'execution_delivery',
          target: { kind: 'execution', id: firstClaim.envelope.executionId },
        }),
      ]),
    );
    expect(second.runId).not.toBe(first.runId);
  });

  it('pages finite run events deterministically and rejects foreign or expired cursors', async () => {
    const first = await commands.submitDevelopmentTask(
      operator,
      task('First event stream'),
    );
    const second = await commands.submitDevelopmentTask(
      operator,
      task('Second event stream'),
    );
    const firstEventId = createUuidV7();
    const secondEventId = createUuidV7();
    await db
      .insertInto('events')
      .values([
        {
          id: firstEventId,
          region_id: regionId,
          event_type: 'operator.test.first',
          payload: { ordinal: 1 },
          stream_key: `operator-test:${first.runId}`,
          sequence_number: '1',
          correlation_id: first.runId,
          source_kind: 'command',
          source_command_id: first.runId,
          source_event_id: null,
          source_execution_id: null,
          source_attempt_id: null,
          source_component_instance_id: null,
          source_port_name: null,
        },
        {
          id: secondEventId,
          region_id: regionId,
          event_type: 'operator.test.second',
          payload: { ordinal: 2 },
          stream_key: `operator-test:${first.runId}`,
          sequence_number: '2',
          correlation_id: first.runId,
          source_kind: 'command',
          source_command_id: first.runId,
          source_event_id: null,
          source_execution_id: null,
          source_attempt_id: null,
          source_component_instance_id: null,
          source_port_name: null,
        },
        {
          id: createUuidV7(),
          region_id: regionId,
          event_type: 'operator.test.foreign',
          payload: { ordinal: 99 },
          stream_key: `operator-test:${second.runId}`,
          sequence_number: '1',
          correlation_id: second.runId,
          source_kind: 'command',
          source_command_id: second.runId,
          source_event_id: null,
          source_execution_id: null,
          source_attempt_id: null,
          source_component_instance_id: null,
          source_port_name: null,
        },
      ])
      .execute();

    const expectedEvents = await db
      .selectFrom('events')
      .select('id')
      .where('correlation_id', '=', first.runId)
      .orderBy('id')
      .execute();
    const firstPage = await queries.listRunEvents(operator, first.runId, {
      limit: 1,
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstPage.resumeCursor).toEqual(firstPage.nextCursor);
    expect(firstPage.complete).toBe(false);

    const secondPage = await queries.listRunEvents(operator, first.runId, {
      limit: 10,
      cursor: firstPage.nextCursor!,
    });
    const observed = [...firstPage.items, ...secondPage.items];
    expect(observed.map((event) => event.id)).toEqual(
      expectedEvents.map((event) => event.id),
    );
    expect(observed.map((event) => event.event_type)).not.toContain(
      'operator.test.foreign',
    );
    expect(new Set(observed.map((event) => event.id)).size).toBe(
      observed.length,
    );
    expect(
      observed.every((event) => event.correlation_id === first.runId),
    ).toBe(true);
    expect(secondPage.complete).toBe(true);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.resumeCursor).toEqual(expect.any(String));

    await expect(
      queries.listRunEvents(operator, second.runId, {
        cursor: firstPage.nextCursor!,
      }),
    ).rejects.toThrow('cursor_run_mismatch');

    const expiredCursor = Buffer.from(
      JSON.stringify({
        v: 1,
        kind: 'run-events',
        runId: first.runId,
        after: createUuidV7(),
      }),
      'utf8',
    ).toString('base64url');
    await expect(
      queries.listRunEvents(operator, first.runId, {
        cursor: expiredCursor,
      }),
    ).rejects.toThrow('cursor_expired');
  });

  it('derives alerts from current durable state and clears them with state', async () => {
    const receipt = await commands.submitDevelopmentTask(
      operator,
      task('Blocked alert'),
    );
    await db
      .updateTable('regions')
      .set({ lifecycle_status: 'blocked' })
      .where('id', '=', regionId)
      .execute();

    const blocked = await queries.listRunAlerts(operator, receipt.runId);
    expect(blocked.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'blocked_work',
          source: { kind: 'region', id: regionId },
        }),
      ]),
    );

    await db
      .updateTable('regions')
      .set({ lifecycle_status: 'running' })
      .where('id', '=', regionId)
      .execute();
    const cleared = await queries.listRunAlerts(operator, receipt.runId);
    expect(cleared.items.some((alert) => alert.kind === 'blocked_work')).toBe(
      false,
    );
  });

  it('lists and reads only artifacts produced by the requested run', async () => {
    const first = await commands.submitDevelopmentTask(
      operator,
      task('First run'),
    );
    const firstClaim = await workers.claim({
      workerId: 'worker-a',
      capabilities: ['retrieve@1'],
    });
    if (!firstClaim.claimed) throw new Error('expected first claim');
    const second = await commands.submitDevelopmentTask(
      operator,
      task('Second run'),
    );
    const secondClaim = await workers.claim({
      workerId: 'worker-b',
      capabilities: ['retrieve@1'],
    });
    if (!secondClaim.claimed) throw new Error('expected second claim');

    const firstArtifactId = createUuidV7();
    const secondArtifactId = createUuidV7();
    await db
      .insertInto('artifacts')
      .values([
        {
          id: firstArtifactId,
          digest_algorithm: 'sha256',
          digest: 'd'.repeat(64),
          size_bytes: '4',
          schema_id: schemaId,
          state: 'committed',
          media_type: 'text/plain',
          committed_locator: 'd'.repeat(64),
          provenance: {},
          tombstoned_at: null,
        },
        {
          id: secondArtifactId,
          digest_algorithm: 'sha256',
          digest: 'e'.repeat(64),
          size_bytes: '4',
          schema_id: schemaId,
          state: 'committed',
          media_type: 'text/plain',
          committed_locator: 'e'.repeat(64),
          provenance: {},
          tombstoned_at: null,
        },
      ])
      .execute();
    await db
      .insertInto('execution_outputs')
      .values([
        {
          id: createUuidV7(),
          execution_id: firstClaim.envelope.executionId,
          attempt_id: firstClaim.envelope.attemptId,
          port_name: 'result',
          artifact_id: firstArtifactId,
          published_event_id: null,
        },
        {
          id: createUuidV7(),
          execution_id: secondClaim.envelope.executionId,
          attempt_id: secondClaim.envelope.attemptId,
          port_name: 'result',
          artifact_id: secondArtifactId,
          published_event_id: null,
        },
      ])
      .execute();

    await expect(
      queries.listRunArtifacts(operator, first.runId),
    ).resolves.toMatchObject({
      items: [{ id: firstArtifactId }],
      nextCursor: null,
    });
    await expect(
      queries.listRunArtifacts(operator, second.runId),
    ).resolves.toMatchObject({
      items: [{ id: secondArtifactId }],
      nextCursor: null,
    });
    await expect(
      queries.readRunArtifact(operator, first.runId, firstArtifactId),
    ).resolves.toMatchObject({ artifactId: firstArtifactId });
    await expect(
      queries.readRunArtifact(operator, first.runId, secondArtifactId),
    ).rejects.toThrow('artifact_not_found');
  });
});
