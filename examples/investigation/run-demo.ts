/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile } from 'node:fs/promises';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Client } from 'pg';
import { parseAllDocuments } from 'yaml';
import {
  createDatabase,
  migrateToLatest,
} from '../../packages/db/src/index.js';
import { buildApp } from '../../apps/control-plane/src/app.js';
import {
  RegistrationService,
  SystemApplicationService,
  CommandService,
} from '../../packages/runtime-core/src/index.js';
import { FilesystemArtifactBlobStore } from '../../packages/artifact-store/src/index.js';

const root = new URL('../../', import.meta.url);
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const token =
  process.env.FACTORY_FLOOR_WORKER_TOKEN ?? 'local-demo-worker-token';
const port = Number(process.env.FACTORY_FLOOR_DEMO_PORT ?? 3109);
const baseUrl = `http://127.0.0.1:${port}`;
const artifactRoot =
  process.env.ARTIFACT_STORE_ROOT ?? '.factory-floor/demo-artifacts';

async function documents(path: string) {
  const text = await readFile(new URL(path, root), 'utf8');
  return parseAllDocuments(text)
    .map((doc) => doc.toJSON())
    .filter(Boolean) as any[];
}

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.query('select 1');
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

function startProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout?.on('data', (data) =>
    process.stdout.write(`[${command}] ${data}`),
  );
  child.stderr?.on('data', (data) =>
    process.stderr.write(`[${command}] ${data}`),
  );
  return child;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      return;
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

async function stop(children: ChildProcess[]) {
  await Promise.allSettled(
    children.map(async (child) => {
      signalProcessTree(child, 'SIGTERM');
      if (child.exitCode === null && child.signalCode === null)
        await Promise.race([
          once(child, 'exit'),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      else await new Promise((resolve) => setTimeout(resolve, 500));
      signalProcessTree(child, 'SIGKILL');
    }),
  );
}

function duplicateKeys(
  rows: readonly Record<string, unknown>[],
  key: (row: Record<string, unknown>) => string | null,
) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = key(row);
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value);
}

async function main() {
  console.log('Starting PostgreSQL and MinIO with docker compose...');
  execFileSync('docker', ['compose', 'up', '-d', 'postgres', 'minio'], {
    cwd: root,
    stdio: 'inherit',
  });
  await waitForPostgres();

  const db = createDatabase(databaseUrl);
  const blobStore = new FilesystemArtifactBlobStore(artifactRoot);
  const children: ChildProcess[] = [];
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const interrupt = () => void stop(children).finally(() => process.exit(130));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);

  try {
    const migration = await migrateToLatest(db);
    if (migration.error) throw migration.error;

    const registrations = new RegistrationService(db);
    for (const doc of await documents('examples/investigation/schemas.yaml'))
      await registrations.registerArtifactSchema(doc);
    const schemaRows = await db
      .selectFrom('artifact_schemas')
      .selectAll()
      .execute();
    const schemaDigests = Object.fromEntries(
      schemaRows.map((row) => [
        `${row.name}.${row.version}`,
        { id: row.id, digest: row.content_digest },
      ]),
    );
    for (const doc of await documents(
      'examples/investigation/declarations/components.yaml',
    ))
      await registrations.registerComponentDefinition(doc);
    for (const doc of await documents('examples/investigation-system.yaml')) {
      if (doc.kind === 'Template') await registrations.registerTemplate(doc);
    }
    for (const doc of await documents('examples/investigation-system.yaml')) {
      if (doc.kind === 'System')
        await new SystemApplicationService(db).apply(doc);
    }

    process.env.CONTROL_PLANE_PUBLIC_URL = baseUrl;
    app = await buildApp({
      database: db,
      artifactBlobStore: blobStore,
      workerAuthToken: token,
    });
    await app.listen({ host: '127.0.0.1', port });
    const env = {
      DATABASE_URL: databaseUrl,
      FACTORY_FLOOR_WORKER_BASE_URL: baseUrl,
      FACTORY_FLOOR_WORKER_TOKEN: token,
      FACTORY_FLOOR_SCHEMA_DIGESTS: JSON.stringify(schemaDigests),
      FACTORY_FLOOR_WORKER_CONCURRENCY: '3',
    };
    children.push(
      startProcess(
        'pnpm',
        ['--filter', '@factory-floor/demo-ts-worker', 'dev'],
        { ...env, FACTORY_FLOOR_WORKER_ID: 'demo-ts-worker' },
      ),
    );
    children.push(
      startProcess(
        'uv',
        ['run', '--project', 'workers/demo-py', 'factory-floor-demo-py'],
        { ...env, FACTORY_FLOOR_WORKER_ID: 'demo-py-worker' },
      ),
    );

    const objective = JSON.parse(
      await readFile(
        new URL('examples/investigation/fixtures/objective.json', root),
        'utf8',
      ),
    );
    const command = await new CommandService(db).submit({
      region: 'investigation',
      commandType: 'investigation.start',
      source: { kind: 'demo' } as any,
      payload: objective,
      idempotencyKey: `demo-${Date.now()}`,
    });
    if (command.disposition !== 'accepted')
      throw new Error(`command was not accepted: ${command.disposition}`);

    const deadline = Date.now() + 120_000;
    let summary: Record<string, unknown> = {};
    for (;;) {
      const executions = await db
        .selectFrom('executions as execution')
        .innerJoin(
          'deliveries as delivery',
          'delivery.id',
          'execution.delivery_id',
        )
        .innerJoin(
          'component_instances as component',
          'component.id',
          'execution.component_instance_id',
        )
        .selectAll('execution')
        .select('component.name as component_name')
        .where('delivery.correlation_id', '=', command.correlationId)
        .execute();
      const attempts = await db
        .selectFrom('execution_attempts as attempt')
        .innerJoin(
          'executions as execution',
          'execution.id',
          'attempt.execution_id',
        )
        .innerJoin(
          'deliveries as delivery',
          'delivery.id',
          'execution.delivery_id',
        )
        .select([
          'attempt.id',
          'attempt.execution_id',
          'attempt.attempt_number',
          'attempt.status',
          'attempt.failure',
        ])
        .where('delivery.correlation_id', '=', command.correlationId)
        .execute();
      const outputs = await db
        .selectFrom('execution_outputs as output')
        .innerJoin(
          'executions as execution',
          'execution.id',
          'output.execution_id',
        )
        .innerJoin(
          'deliveries as delivery',
          'delivery.id',
          'execution.delivery_id',
        )
        .select(['output.id', 'output.execution_id', 'output.port_name'])
        .where('delivery.correlation_id', '=', command.correlationId)
        .execute();
      const deliveries = await db
        .selectFrom('deliveries as delivery')
        .select([
          'delivery.id',
          'delivery.source_event_id',
          'delivery.target_component_instance_id',
          'delivery.target_port_name',
          'delivery.status',
        ])
        .where('delivery.correlation_id', '=', command.correlationId)
        .execute();

      const failedAttempts = attempts.filter(
        (attempt) => attempt.status === 'failed',
      );
      const finalOutputPorts = outputs
        .filter((output) =>
          ['result', 'evidence-bundle', 'uncertainty-report'].includes(
            output.port_name,
          ),
        )
        .map((output) => output.port_name)
        .sort();
      const duplicateOutputs = duplicateKeys(
        outputs as unknown as Record<string, unknown>[],
        (row) => `${String(row.execution_id)}:${String(row.port_name)}`,
      );
      const duplicateDeliveries = duplicateKeys(
        deliveries as unknown as Record<string, unknown>[],
        (row) =>
          row.source_event_id === null
            ? null
            : [
                row.source_event_id,
                row.target_component_instance_id,
                row.target_port_name,
              ].join(':'),
      );
      const failedCode = (failedAttempts[0]?.failure as any)?.code;

      summary = {
        commandId: command.commandId,
        correlationId: command.correlationId,
        executions: executions.length,
        attempts: attempts.length,
        completedExecutions: executions.filter(
          (execution) => execution.status === 'completed',
        ).length,
        failedAttempts: failedAttempts.length,
        failedAttemptCode: failedCode,
        componentNames: executions
          .map((execution) => execution.component_name)
          .sort(),
        finalOutputPorts,
        duplicateOutputs,
        duplicateDeliveries,
      };

      const completed =
        executions.length === 6 &&
        executions.every((execution) => execution.status === 'completed') &&
        attempts.length === 7 &&
        failedAttempts.length === 1 &&
        failedCode === 'DEMO_FIRST_ATTEMPT_INTENTIONAL_FAILURE' &&
        finalOutputPorts.join(',') ===
          'evidence-bundle,result,uncertainty-report' &&
        duplicateOutputs.length === 0 &&
        duplicateDeliveries.length === 0 &&
        deliveries.every((delivery) => delivery.status === 'completed');
      if (completed) break;
      if (Date.now() > deadline)
        throw new Error(`demo timed out: ${JSON.stringify(summary)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    console.log(JSON.stringify({ status: 'completed', ...summary }, null, 2));
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await stop(children);
    if (app !== undefined) await app.close();
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
