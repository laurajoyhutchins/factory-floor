import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import { parseAllDocuments } from 'yaml';

const root = new URL('../', import.meta.url);
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const token =
  process.env.FACTORY_FLOOR_WORKER_TOKEN ?? 'local-demo-worker-token';
const port = Number(process.env.FACTORY_FLOOR_ACCEPTANCE_PORT ?? 3112);
const baseUrl = `http://127.0.0.1:${port}`;
const leaseMs = Number(process.env.FACTORY_FLOOR_ACCEPTANCE_LEASE_MS ?? 2_000);
const timeoutMs = Number(
  process.env.FACTORY_FLOOR_ACCEPTANCE_TIMEOUT_MS ?? 120_000,
);
const correlationId = `m1-live-restart-${Date.now()}`;
const children = new Map();
const useGroups = process.platform !== 'win32';

function log(message, fields = {}) {
  globalThis.console.log(JSON.stringify({ event: message, ...fields }));
}

function spawnProcess(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: useGroups,
  });
  children.set(name, child);
  child.stdout?.on('data', (data) => process.stdout.write(`[${name}] ${data}`));
  child.stderr?.on('data', (data) => process.stderr.write(`[${name}] ${data}`));
  child.on('exit', (code, signal) => {
    children.delete(name);
    log('process.exited', { name, code, signal });
  });
  return child;
}

function signalProcess(child, signal) {
  if (child?.pid === undefined) return;
  if (useGroups) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    return;
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

async function stopProcess(name, signal = 'SIGTERM') {
  const child = children.get(name);
  if (!child) return;
  signalProcess(child, signal);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await Promise.race([exited, sleep(3_000)]);
  signalProcess(child, 'SIGKILL');
}

async function stopAll() {
  await Promise.all([...children.keys()].map((name) => stopProcess(name)));
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
      await sleep(500);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

async function waitForHttp(path) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await globalThis.fetch(`${baseUrl}${path}`);
      if (response.ok) return;
    } catch {
      // Retry until the health endpoint becomes reachable.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await sleep(100);
  }
}

async function documents(path) {
  const text = await readFile(new URL(path, root), 'utf8');
  return parseAllDocuments(text)
    .map((doc) => doc.toJSON())
    .filter(Boolean);
}

async function post(path, body) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `${path} failed ${response.status}: ${JSON.stringify(payload)}`,
    );
  return payload;
}

async function query(sql, params = []) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function schemaDigests() {
  const rows = await query(
    'select id, name, version, content_digest from artifact_schemas',
  );
  return Object.fromEntries(
    rows.map((row) => [
      `${row.name}.${row.version}`,
      { id: row.id, digest: row.content_digest },
    ]),
  );
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await predicate();
    if (last) return last;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

function controlPlaneEnv() {
  return {
    DATABASE_URL: databaseUrl,
    FACTORY_FLOOR_WORKER_TOKEN: token,
    PORT: String(port),
    HOST: '127.0.0.1',
    FACTORY_FLOOR_CONTROL_PLANE_URL: baseUrl,
    CONTROL_PLANE_PUBLIC_URL: baseUrl,
    WORKER_LEASE_DURATION_MS: String(leaseMs),
    ARTIFACT_STORE_ROOT: '.factory-floor/acceptance-artifacts',
  };
}

async function startControlPlane(name = 'control-plane') {
  const child = spawnProcess(
    name,
    'pnpm',
    ['--filter', '@factory-floor/control-plane', 'dev'],
    controlPlaneEnv(),
  );
  await waitForHttp('/health');
  return child;
}

function startWorkers(digests) {
  const env = {
    DATABASE_URL: databaseUrl,
    FACTORY_FLOOR_WORKER_BASE_URL: baseUrl,
    FACTORY_FLOOR_WORKER_TOKEN: token,
    FACTORY_FLOOR_SCHEMA_DIGESTS: JSON.stringify(digests),
    FACTORY_FLOOR_WORKER_CONCURRENCY: '3',
    FACTORY_FLOOR_VERIFIER_DELAY_MS: String(Math.max(leaseMs * 3, 6_000)),
  };
  spawnProcess(
    'demo-ts-worker',
    'pnpm',
    ['--filter', '@factory-floor/demo-ts-worker', 'dev'],
    { ...env, FACTORY_FLOOR_WORKER_ID: 'acceptance-ts-worker' },
  );
  spawnProcess(
    'demo-py-worker',
    'uv',
    ['run', '--project', 'workers/demo-py', 'factory-floor-demo-py'],
    { ...env, FACTORY_FLOOR_WORKER_ID: 'acceptance-py-worker' },
  );
}

function duplicates(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = key(row);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([value]) => value);
}

async function collectSummary(staleAttempt) {
  const attempts = await query(
    `select a.id, a.execution_id, a.attempt_number, a.status, a.lease_token, a.failure, ci.name as component_name from execution_attempts a join executions e on e.id=a.execution_id join deliveries d on d.id=e.delivery_id join component_instances ci on ci.id=e.component_instance_id where d.correlation_id=$1 order by ci.name, a.attempt_number`,
    [correlationId],
  );
  const executions = await query(
    `select e.id, e.status, ci.name as component_name from executions e join deliveries d on d.id=e.delivery_id join component_instances ci on ci.id=e.component_instance_id where d.correlation_id=$1`,
    [correlationId],
  );
  const outputs = await query(
    `select o.execution_id, o.port_name, o.artifact_id from execution_outputs o join executions e on e.id=o.execution_id join deliveries d on d.id=e.delivery_id where d.correlation_id=$1`,
    [correlationId],
  );
  const deliveries = await query(
    `select source_event_id, target_component_instance_id, target_port_name, status from deliveries where correlation_id=$1`,
    [correlationId],
  );
  const events = await query(
    `select event_type, payload from events where event_type='runtime.recovery.completed' order by created_at desc limit 5`,
  );
  const projections = await query(
    `select name, high_water_event_id, rebuilt_at from projection_checkpoints order by name`,
  );
  return {
    correlationId,
    executions: executions.length,
    completedExecutions: executions.filter((row) => row.status === 'completed')
      .length,
    attempts: attempts.map((row) => ({
      id: row.id,
      executionId: row.execution_id,
      attemptNumber: row.attempt_number,
      status: row.status,
      componentName: row.component_name,
      failureCode: row.failure?.code ?? null,
    })),
    failedAttempts: attempts.filter((row) => row.status === 'failed').length,
    abandonedAttempts: attempts.filter((row) => row.status === 'abandoned')
      .length,
    replacementAttempts: attempts.filter(
      (row) =>
        row.component_name === 'verify' &&
        row.attempt_number > staleAttempt.attemptNumber,
    ).length,
    duplicateOutputs: duplicates(
      outputs,
      (row) => `${row.execution_id}:${row.port_name}`,
    ),
    duplicateDeliveries: duplicates(deliveries, (row) =>
      row.source_event_id
        ? `${row.source_event_id}:${row.target_component_instance_id}:${row.target_port_name}`
        : null,
    ),
    staleAttemptCommitted: attempts.some(
      (row) => row.id === staleAttempt.id && row.status === 'completed',
    ),
    recoveryEvent:
      events.find(
        (row) => Number(row.payload?.expiredAttemptsAbandoned ?? 0) > 0,
      ) ?? null,
    projectionsCaughtUp:
      projections.length > 0 &&
      projections.every(
        (row) => row.high_water_event_id !== null || row.rebuilt_at !== null,
      ),
  };
}

async function main() {
  process.once('SIGINT', () => void stopAll().finally(() => process.exit(130)));
  process.once(
    'SIGTERM',
    () => void stopAll().finally(() => process.exit(143)),
  );
  try {
    execFileSync(
      'docker',
      ['compose', 'down', '--volumes', '--remove-orphans'],
      { cwd: root, stdio: 'inherit' },
    );
    execFileSync('docker', ['compose', 'up', '-d', 'postgres', 'minio'], {
      cwd: root,
      stdio: 'inherit',
    });
    await waitForPostgres();
    execFileSync('pnpm', ['db:migrate'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    await startControlPlane();
    for (const doc of await documents('examples/investigation/schemas.yaml'))
      await post('/api/v1/registrations/artifact-schemas', doc);
    for (const doc of await documents(
      'examples/investigation/declarations/components.yaml',
    ))
      await post('/api/v1/registrations/component-definitions', doc);
    for (const doc of await documents('examples/investigation-system.yaml'))
      if (doc.kind === 'Template')
        await post('/api/v1/registrations/templates', doc);
    for (const doc of await documents('examples/investigation-system.yaml'))
      if (doc.kind === 'System') await post('/api/v1/systems/apply', doc);
    startWorkers(await schemaDigests());
    const objective = JSON.parse(
      await readFile(
        new URL('examples/investigation/fixtures/objective.json', root),
        'utf8',
      ),
    );
    await post('/api/v1/commands', {
      region: 'investigation',
      commandType: 'investigation.start',
      source: { kind: 'acceptance' },
      payload: objective,
      correlationId,
      idempotencyKey: correlationId,
    });

    const staleAttempt = await waitUntil(async () => {
      const rows = await query(
        `select a.id, a.execution_id, a.attempt_number, a.lease_token, a.lifecycle_epoch from execution_attempts a join executions e on e.id=a.execution_id join deliveries d on d.id=e.delivery_id join component_instances ci on ci.id=e.component_instance_id where d.correlation_id=$1 and ci.name='verify' and a.status='running' and a.attempt_number=2`,
        [correlationId],
      );
      return (
        rows[0] && {
          id: rows[0].id,
          executionId: rows[0].execution_id,
          attemptNumber: rows[0].attempt_number,
          leaseToken: rows[0].lease_token,
          lifecycleEpoch: rows[0].lifecycle_epoch,
        }
      );
    }, 'verification attempt 2 running');
    log('verification.in_flight', staleAttempt);

    await stopProcess('control-plane', 'SIGTERM');
    await waitUntil(async () => {
      const rows = await query(
        'select lease_expires_at <= now() as expired from execution_attempts where id=$1',
        [staleAttempt.id],
      );
      return rows[0]?.expired === true;
    }, 'pre-restart lease expiration');
    await startControlPlane('control-plane-restarted');

    await waitUntil(async () => {
      const rows = await query(
        'select status from execution_attempts where id=$1',
        [staleAttempt.id],
      );
      return rows[0]?.status === 'abandoned';
    }, 'startup recovery abandonment');

    const staleResponse = await globalThis.fetch(
      `${baseUrl}/worker/v1/results`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          protocolVersion: '1.0',
          executionId: staleAttempt.executionId,
          attemptId: staleAttempt.id,
          leaseToken: staleAttempt.leaseToken,
          lifecycleEpoch: staleAttempt.lifecycleEpoch,
          status: 'completed',
          stagedArtifacts: [],
          proposedEvents: [],
          externalActionProposals: [],
          resourceUsage: {
            cpuMilliseconds: 0,
            wallMilliseconds: 0,
            inputBytes: 0,
            outputBytes: 0,
            externalCalls: 0,
          },
        }),
      },
    );
    if (![409].includes(staleResponse.status))
      throw new Error(
        `stale result was not fenced: ${staleResponse.status} ${await staleResponse.text()}`,
      );

    const summary = await waitUntil(async () => {
      const current = await collectSummary(staleAttempt);
      return current.executions === 6 &&
        current.completedExecutions === 6 &&
        current.failedAttempts === 1 &&
        current.abandonedAttempts >= 1 &&
        current.replacementAttempts >= 1 &&
        current.duplicateOutputs.length === 0 &&
        current.duplicateDeliveries.length === 0 &&
        current.staleAttemptCommitted === false &&
        current.recoveryEvent &&
        current.projectionsCaughtUp
        ? current
        : null;
    }, 'investigation completion after live restart');
    globalThis.console.log(
      JSON.stringify({ status: 'completed', ...summary }, null, 2),
    );
  } finally {
    await stopAll();
  }
}

main().catch(async (error) => {
  globalThis.console.error(error);
  await stopAll();
  process.exitCode = 1;
});
