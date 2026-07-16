import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';

const outDir =
  process.env.FACTORY_FLOOR_EVIDENCE_DIR ?? '.factory-floor/evidence/m1';
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const startedAt =
  process.env.FACTORY_FLOOR_ACCEPTANCE_STARTED_AT ?? new Date().toISOString();
const port = Number(process.env.FACTORY_FLOOR_EVIDENCE_PORT ?? 3115);
const baseUrl = `http://127.0.0.1:${port}`;
const useProcessGroups = process.platform !== 'win32';
let controlPlane;

function signalProcess(child, signal) {
  if (child?.pid === undefined) return;
  if (useProcessGroups) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    return;
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

async function stopControlPlane() {
  if (!controlPlane) return;
  signalProcess(controlPlane, 'SIGTERM');
  await Promise.race([
    new Promise((resolve) => controlPlane.once('exit', resolve)),
    sleep(3_000),
  ]);
  signalProcess(controlPlane, 'SIGKILL');
  controlPlane = undefined;
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await globalThis.fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The operator API process may still be binding its listener.
    }
    if (Date.now() > deadline)
      throw new Error('timed out waiting for the evidence inspection API');
    await sleep(100);
  }
}

async function startControlPlane() {
  controlPlane = spawn(
    'pnpm',
    ['--filter', '@factory-floor/control-plane', 'dev'],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        HOST: '127.0.0.1',
        ARTIFACT_STORE_ROOT: '.factory-floor/demo-artifacts',
        WORKER_API_BEARER_TOKEN: 'm1-evidence-worker-token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: useProcessGroups,
    },
  );
  controlPlane.stdout?.on('data', (data) =>
    process.stdout.write(`[evidence-control-plane] ${data}`),
  );
  controlPlane.stderr?.on('data', (data) =>
    process.stderr.write(`[evidence-control-plane] ${data}`),
  );
  await waitForHealth();
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

async function inspect(path) {
  const response = await globalThis.fetch(`${baseUrl}${path}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `inspection ${path} failed ${response.status}: ${JSON.stringify(payload)}`,
    );
  return payload;
}

async function inspectAll(path) {
  const items = [];
  let cursor;
  do {
    const url = new URL(path, baseUrl);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await globalThis.fetch(url);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        `inspection ${url.pathname} failed ${response.status}: ${JSON.stringify(payload)}`,
      );
    items.push(...(payload.items ?? []));
    cursor = payload.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

function extractJsonObject(text, marker) {
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error(`missing JSON marker ${marker}`);
  const start = text.indexOf('{', markerIndex);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1));
    }
  }
  throw new Error(`unterminated JSON object after ${marker}`);
}

function runJson(command, args, marker) {
  const output = execFileSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  return extractJsonObject(output, marker);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, sanitize(child)]),
    );
  if (typeof value !== 'string') return value;
  return value
    .replace(/Bearer\s+[^\s"]+/gi, 'Bearer [REDACTED]')
    .replace(/factory_floor_dev_password/g, '[REDACTED]')
    .replace(/file:\/\/[^\s"]+/gi, '[REDACTED_LOCATOR]')
    .replace(/https?:\/\/[^\s"]*token=[^\s"&]+/gi, '[REDACTED_URL]');
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const environment = {
    node: execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(),
    pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
    uv: execFileSync('uv', ['--version'], { encoding: 'utf8' }).trim(),
    githubActions: process.env.GITHUB_ACTIONS === 'true',
    codespaces: process.env.CODESPACES === 'true',
    runnerOs: process.env.RUNNER_OS ?? null,
    runnerName: process.env.RUNNER_NAME ?? null,
    cleanCheckoutAttested:
      process.env.FACTORY_FLOOR_CLEAN_CHECKOUT === '1',
  };
  const ledgerText = execFileSync('pnpm', ['conformance:check'], {
    encoding: 'utf8',
  }).trim();

  const replayCountsBefore = (
    await query(`select
      (select count(*)::int from deliveries) as deliveries,
      (select count(*)::int from executions) as executions,
      (select count(*)::int from external_actions) as external_actions`)
  )[0];
  const projectionReplay = runJson(
    'pnpm',
    ['projections:rebuild'],
    '{\n  "status": "completed"',
  );
  const replayCountsAfter = (
    await query(`select
      (select count(*)::int from deliveries) as deliveries,
      (select count(*)::int from executions) as executions,
      (select count(*)::int from external_actions) as external_actions`)
  )[0];
  const reconciliation = runJson(
    'pnpm',
    ['artifacts:reconcile'],
    '{\n  "dryRun"',
  );

  await startControlPlane();
  const [
    regions,
    events,
    deliveries,
    executions,
    attempts,
    artifacts,
    resources,
    policyDecisions,
    projections,
  ] = await Promise.all([
    inspectAll('/api/v1/inspect/regions'),
    inspectAll('/api/v1/inspect/events'),
    inspectAll('/api/v1/inspect/deliveries'),
    inspectAll('/api/v1/inspect/executions'),
    inspectAll('/api/v1/inspect/attempts'),
    inspectAll('/api/v1/inspect/artifacts'),
    inspectAll('/api/v1/inspect/resources'),
    inspectAll('/api/v1/inspect/policy-decisions'),
    inspectAll('/api/v1/inspect/projections'),
  ]);
  const traces = await Promise.all(
    executions.map((execution) =>
      inspect(`/api/v1/inspect/executions/${execution.id}`),
    ),
  );
  const lineage = await Promise.all(
    artifacts.map((artifact) =>
      inspect(`/api/v1/inspect/artifacts/${artifact.id}/lineage`),
    ),
  );
  await stopControlPlane();

  const commands = await query(
    `select id, command_type, region_id, correlation_id, status, source,
            request_digest, rejection, accepted_at, rejected_at, created_at
       from commands order by created_at, id`,
  );
  const duplicateOutputs = await query(
    `select execution_id, port_name, count(*)::int as count
       from execution_outputs
      group by execution_id, port_name having count(*) > 1`,
  );
  const duplicateDeliveries = await query(
    `select source_event_id, target_component_instance_id, target_port_name,
            count(*)::int as count
       from deliveries
      where source_event_id is not null
      group by source_event_id, target_component_instance_id, target_port_name
     having count(*) > 1`,
  );
  const restartEvidence = extractJsonObject(
    await readFile(join(outDir, 'restart.log'), 'utf8'),
    '{\n  "status": "completed"',
  );
  const cancellationEvidence = await readJson(
    join(outDir, 'cancellation-evidence.json'),
  );
  const unresolvedDeliveries = deliveries.filter(
    (delivery) =>
      !['completed', 'cancelled', 'dead_lettered'].includes(delivery.status),
  );
  const failedAttempt = attempts.find(
    (attempt) => attempt.status === 'failed',
  );
  const replacementAttempt = failedAttempt
    ? attempts.find(
        (attempt) =>
          attempt.execution_id === failedAttempt.execution_id &&
          attempt.attempt_number > failedAttempt.attempt_number &&
          attempt.status === 'completed',
      )
    : undefined;
  const replaySideEffectsUnchanged =
    JSON.stringify(replayCountsBefore) === JSON.stringify(replayCountsAfter);

  const checks = {
    finalInvestigation:
      executions.length === 6 &&
      executions.every((execution) => execution.status === 'completed') &&
      attempts.length === 7 &&
      deliveries.every((delivery) => delivery.status === 'completed'),
    deliberateFailureAndRetry:
      Boolean(failedAttempt) && Boolean(replacementAttempt),
    restartRecovery:
      restartEvidence.status === 'completed' &&
      restartEvidence.abandonedAttempts >= 1 &&
      restartEvidence.replacementAttempts >= 1 &&
      restartEvidence.staleResultCode === 'inactive_attempt' &&
      restartEvidence.duplicateOutputs.length === 0 &&
      restartEvidence.duplicateDeliveries.length === 0,
    cancellationFencing:
      cancellationEvidence.status === 'completed' &&
      cancellationEvidence.region.lifecycle_status === 'cancelled' &&
      cancellationEvidence.region.lifecycle_epoch === 1 &&
      cancellationEvidence.staleResultCode === 'inactive_attempt' &&
      cancellationEvidence.committedOutputs === 0,
    terminalDeliveries: unresolvedDeliveries.length === 0,
    noDuplicateOutputs: duplicateOutputs.length === 0,
    noDuplicateDeliveries: duplicateDeliveries.length === 0,
    artifactIdentityAndProvenance:
      artifacts.length > 0 &&
      artifacts.every(
        (artifact) =>
          artifact.id &&
          artifact.digest_algorithm === 'sha256' &&
          /^[a-f0-9]{64}$/.test(artifact.digest) &&
          artifact.schema_id &&
          artifact.schema_digest &&
          artifact.media_type &&
          artifact.state === 'committed' &&
          artifact.provenance,
      ) &&
      lineage.length === artifacts.length,
    resourceAttribution:
      resources.length > 0 &&
      resources.every(
        (resource) =>
          resource.region_id &&
          resource.resource_type &&
          resource.quantity !== null &&
          resource.unit &&
          (resource.execution_id || resource.external_action_id),
      ) &&
      Boolean(
        failedAttempt &&
          resources.some(
            (resource) => resource.attempt_id === failedAttempt.id,
          ),
      ) &&
      Boolean(
        replacementAttempt &&
          resources.some(
            (resource) => resource.attempt_id === replacementAttempt.id,
          ),
      ),
    durablePolicyDecision:
      policyDecisions.length > 0 &&
      policyDecisions.every(
        (decision) =>
          decision.policy_id &&
          decision.policy_name &&
          decision.policy_version &&
          decision.evaluator_version &&
          decision.subject_kind &&
          decision.subject_id &&
          decision.normalized_inputs &&
          decision.outcome &&
          decision.reason !== null &&
          decision.modifications !== null &&
          (decision.outcome !== 'require_approval' ||
            (decision.approval_id && decision.approval_status === 'requested')),
      ),
    completeTrace:
      traces.length === executions.length &&
      traces.every(
        (trace) =>
          trace.execution &&
          trace.causalChain?.delivery &&
          Array.isArray(trace.causalChain?.attempts) &&
          Array.isArray(trace.causalChain?.events) &&
          Array.isArray(trace.causalChain?.outputs),
      ),
    projectionReplayNoSideEffects: replaySideEffectsUnchanged,
    reconciliationInspectable:
      reconciliation.dryRun === true &&
      Array.isArray(reconciliation.unresolved) &&
      reconciliation.unresolved.length === 0,
    projectionsCaughtUp:
      projections.length > 0 &&
      projections.every(
        (projection) =>
          projection.lastEventId !== null || projection.updatedAt !== null,
      ),
    cleanEnvironment: environment.cleanCheckoutAttested,
    deferred: ['M1-CONF-006', 'M1-CONF-007', 'M1-CONF-015'],
    formattingBaseline:
      'Repository-wide Prettier drift is pre-existing; Task 12C files are reviewed independently and global cleanup is tracked outside this acceptance change.',
  };
  const passed = Object.entries(checks)
    .filter(([key]) => !['deferred', 'formattingBaseline'].includes(key))
    .every(([, value]) => value === true);
  const evidence = sanitize({
    schemaVersion: 2,
    status: passed ? 'passed' : 'failed',
    commitSha,
    startedAt,
    completedAt: new Date().toISOString(),
    environment,
    conformanceLedger: { summary: ledgerText },
    commands,
    regions,
    executions,
    attempts,
    deliveries,
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      committed_locator: artifact.committed_locator
        ? '[REDACTED_LOCATOR]'
        : null,
    })),
    resources,
    events,
    policyDecisions,
    traces,
    lineage,
    restartEvidence,
    cancellationEvidence,
    projectionReplay: {
      result: projectionReplay,
      countsBefore: replayCountsBefore,
      countsAfter: replayCountsAfter,
    },
    reconciliation,
    projections,
    checks,
  });
  await writeFile(
    join(outDir, 'acceptance-evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
  const summary = `# Milestone 1 acceptance evidence\n\n- Status: ${evidence.status}\n- Commit: ${commitSha}\n- Started: ${startedAt}\n- Completed: ${evidence.completedAt}\n- Environment: ${environment.codespaces ? 'Codespaces' : environment.githubActions ? 'GitHub Actions clean hosted checkout' : 'local checkout'}\n- Commands: ${commands.length}\n- Logical executions: ${executions.length}\n- Attempts: ${attempts.length}\n- Deliveries: ${deliveries.length}\n- Artifacts: ${artifacts.length}\n- Resource entries: ${resources.length}\n- Policy decisions: ${policyDecisions.length}\n- Duplicate outputs: ${duplicateOutputs.length}\n- Duplicate deliveries: ${duplicateDeliveries.length}\n- Non-terminal deliveries: ${unresolvedDeliveries.length}\n- Deferred invariants: ${checks.deferred.join(', ')}\n- Formatting note: ${checks.formattingBaseline}\n\nSee \`acceptance-evidence.json\` for sanitized machine-readable details.\n`;
  await writeFile(join(outDir, 'SUMMARY.md'), summary);
  globalThis.console.log(
    JSON.stringify({ status: evidence.status, outDir, checks }, null, 2),
  );
  if (!passed) process.exitCode = 1;
}

process.once('SIGINT', () => void stopControlPlane().finally(() => process.exit(130)));
process.once('SIGTERM', () =>
  void stopControlPlane().finally(() => process.exit(143)),
);
main()
  .catch((error) => {
    globalThis.console.error(error);
    process.exitCode = 1;
  })
  .finally(stopControlPlane);
