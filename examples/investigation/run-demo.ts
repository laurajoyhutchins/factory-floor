/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile } from 'node:fs/promises';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { parseAllDocuments } from 'yaml';
import { createDatabase, migrateToLatest } from '../../packages/db/src/index.js';
import { buildApp } from '../../apps/control-plane/src/app.js';
import { RegistrationService, SystemApplicationService, CommandService } from '../../packages/runtime-core/src/index.js';
import { FilesystemArtifactBlobStore } from '../../packages/artifact-store/src/index.js';

const root = new URL('../../', import.meta.url);
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const token = process.env.FACTORY_FLOOR_WORKER_TOKEN ?? 'local-demo-worker-token';
const port = Number(process.env.FACTORY_FLOOR_DEMO_PORT ?? 3109);
const baseUrl = `http://127.0.0.1:${port}`;
const artifactRoot = process.env.ARTIFACT_STORE_ROOT ?? '.factory-floor/demo-artifacts';

async function documents(path: string) {
  const text = await readFile(new URL(path, root), 'utf8');
  return parseAllDocuments(text).map((doc) => doc.toJSON()).filter(Boolean) as any[];
}

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const db = createDatabase(databaseUrl);
      await db.selectFrom('kysely_migration').selectAll().limit(1).execute().catch(() => undefined);
      await db.destroy();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function startProcess(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (data) => process.stdout.write(`[${command}] ${data}`));
  child.stderr?.on('data', (data) => process.stderr.write(`[${command}] ${data}`));
  return child;
}

async function stop(children: ChildProcess[]) {
  await Promise.allSettled(children.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }));
}

async function main() {
  console.log('Starting PostgreSQL and MinIO with docker compose...');
  execFileSync('docker', ['compose', 'up', '-d', 'postgres', 'minio'], { cwd: root, stdio: 'inherit' });
  await waitForPostgres();
  const db = createDatabase(databaseUrl);
  const blobStore = new FilesystemArtifactBlobStore(artifactRoot);
  const children: ChildProcess[] = [];
  const interrupt = () => void stop(children).finally(() => process.exit(130));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const migration = await migrateToLatest(db);
    if (migration.error) throw migration.error;
    const registrations = new RegistrationService(db);
    for (const doc of await documents('examples/investigation/schemas.yaml')) await registrations.registerArtifactSchema(doc);
    const schemaRows = await db.selectFrom('artifact_schemas').selectAll().execute();
    const schemaDigests = Object.fromEntries(schemaRows.map((row) => [`${row.name}.${row.version}`, { id: row.id, digest: row.content_digest }]));
    for (const doc of await documents('examples/investigation/declarations/components.yaml')) await registrations.registerComponentDefinition(doc);
    for (const doc of await documents('examples/investigation-system.yaml')) {
      if (doc.kind === 'Template') await registrations.registerTemplate(doc);
    }
    for (const doc of await documents('examples/investigation-system.yaml')) {
      if (doc.kind === 'System') await new SystemApplicationService(db).apply(doc);
    }

    const app = await buildApp({ database: db, artifactBlobStore: blobStore, workerAuthToken: token });
    await app.listen({ host: '127.0.0.1', port });
    const env = { DATABASE_URL: databaseUrl, FACTORY_FLOOR_WORKER_BASE_URL: baseUrl, FACTORY_FLOOR_WORKER_TOKEN: token, FACTORY_FLOOR_SCHEMA_DIGESTS: JSON.stringify(schemaDigests), FACTORY_FLOOR_WORKER_CONCURRENCY: '3' };
    children.push(startProcess('pnpm', ['--filter', '@factory-floor/demo-ts-worker', 'dev'], { ...env, FACTORY_FLOOR_WORKER_ID: 'demo-ts-worker' }));
    children.push(startProcess('uv', ['run', '--project', 'workers/demo-py', 'factory-floor-demo-py'], { ...env, FACTORY_FLOOR_WORKER_ID: 'demo-py-worker' }));

    const objective = JSON.parse(await readFile(new URL('examples/investigation/fixtures/objective.json', root), 'utf8'));
    const command = await new CommandService(db).submit({ region: 'investigation', commandType: 'investigation.start', source: { kind: 'demo' } as any, payload: objective, idempotencyKey: `demo-${Date.now()}` });
    if (command.disposition !== 'accepted') throw new Error(`command was not accepted: ${command.disposition}`);

    const deadline = Date.now() + 120_000;
    let summary: any;
    for (;;) {
      const executions = await db.selectFrom('executions').selectAll().execute();
      const attempts = await db.selectFrom('execution_attempts').selectAll().execute();
      const outputs = await db.selectFrom('execution_outputs').selectAll().execute();
      const finalOutputs = outputs.filter((output) => ['result', 'evidence-bundle', 'uncertainty-report'].includes(output.port_name));
      summary = { commandId: command.commandId, correlationId: command.correlationId, executions: executions.length, attempts: attempts.length, completedExecutions: executions.filter((e) => e.status === 'completed').length, failedAttempts: attempts.filter((a) => a.status === 'failed').length, finalOutputPorts: finalOutputs.map((o) => o.port_name).sort() };
      if (finalOutputs.length === 3 && executions.filter((e) => e.status === 'completed').length >= 6) break;
      if (Date.now() > deadline) throw new Error(`demo timed out: ${JSON.stringify(summary)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.log(JSON.stringify({ status: 'completed', ...summary }, null, 2));
    await app.close();
  } finally {
    await stop(children);
    await db.destroy();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
