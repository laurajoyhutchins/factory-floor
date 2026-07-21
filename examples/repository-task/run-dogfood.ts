/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { parseAllDocuments } from 'yaml';
import { buildApp } from '../../apps/control-plane/src/app.js';
import { FilesystemArtifactBlobStore } from '../../packages/artifact-store/src/index.js';
import {
  createDatabase,
  migrateToLatest,
} from '../../packages/db/src/index.js';
import {
  CommandService,
  RegistrationService,
  SystemApplicationService,
} from '../../packages/runtime-core/src/index.js';

const root = new URL('../../', import.meta.url);
const rootPath = fileURLToPath(root);
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const token =
  process.env.FACTORY_FLOOR_WORKER_TOKEN ??
  'local-repository-task-worker-token';
const port = Number(process.env.FACTORY_FLOOR_REPOSITORY_TASK_PORT ?? 3111);
const baseUrl = `http://127.0.0.1:${port}`;
const outputRoot = join(rootPath, '.factory-floor', 'repository-task-dogfood');
const artifactRoot = join(outputRoot, 'artifacts');
const outputPorts = [
  'authored-plan',
  'normalized-plan',
  'generation-graph',
  'patch',
  'evidence',
  'diagnostics',
  'disposition',
] as const;

async function documents(path: string): Promise<any[]> {
  const text = await readFile(new URL(path, root), 'utf8');
  return parseAllDocuments(text)
    .map((document) => document.toJSON())
    .filter(Boolean) as any[];
}

async function waitForPostgres(): Promise<void> {
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

async function stop(children: ChildProcess[]): Promise<void> {
  await Promise.allSettled(
    children.map(async (child) => {
      signalProcessTree(child, 'SIGTERM');
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          once(child, 'exit'),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
      signalProcessTree(child, 'SIGKILL');
    }),
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

async function repositorySnapshot(): Promise<{
  files: Record<string, string>;
}> {
  const files = git(
    'ls-files',
    '--',
    'workers/repository-task-ts/src',
    'workers/repository-task-ts/test',
  )
    .split('\n')
    .filter(Boolean)
    .sort();
  return {
    files: Object.fromEntries(
      await Promise.all(
        files.map(async (path) => [
          path,
          await readFile(join(rootPath, path), 'utf8'),
        ]),
      ),
    ),
  };
}

function repositoryIdentity(
  baseRevision: string,
  snapshot: { files: Record<string, string> },
) {
  const canonicalFiles = Object.keys(snapshot.files)
    .sort()
    .map((path) => [path, snapshot.files[path]] as const);
  return {
    repository: { owner: 'laurajoyhutchins', name: 'factory-floor' },
    baseRevision,
    snapshotDigest: sha256(JSON.stringify(canonicalFiles)),
    dirtyStatePolicy: 'require-clean' as const,
  };
}

function authoredPlan(baseRevision: string): string {
  return `---
schemaVersion: 1
repository:
  owner: laurajoyhutchins
  name: factory-floor
  baseRevision: ${baseRevision}
allowedPaths:
  - workers/repository-task-ts/src/repository-task-worker-component.ts
  - workers/repository-task-ts/test/repository-task-worker-component.test.ts
  - workers/repository-task-ts/src/index.ts
recipe:
  name: typescript-module
  version: '1'
  inputs:
    package: '@factory-floor/repository-task-worker'
    moduleName: repository-task-worker-component
    responsibility: Describe the bounded durable worker that compiles, applies, verifies, and retains repository-task evidence.
    exports:
      - name: REPOSITORY_TASK_WORKER_COMPONENT
        typeName: RepositoryTaskWorkerComponent
        value:
          capabilities:
            - apply-isolated-patch
            - compile-authored-plan
            - retain-evidence
            - run-trusted-verification
          name: repository-task-worker
          responsibility: Describe the bounded durable worker that compiles, applies, verifies, and retains repository-task evidence.
    testCases:
      - name: describes the bounded durable repository-task worker
        exportName: REPOSITORY_TASK_WORKER_COMPONENT
        expected:
          capabilities:
            - apply-isolated-patch
            - compile-authored-plan
            - retain-evidence
            - run-trusted-verification
          name: repository-task-worker
          responsibility: Describe the bounded durable worker that compiles, applies, verifies, and retains repository-task evidence.
outputContract:
  outputs:
    - name: implementation
      kind: file
      path: workers/repository-task-ts/src/repository-task-worker-component.ts
      mediaType: text/typescript
      required: true
    - name: public-export
      kind: export
      path: workers/repository-task-ts/src/index.ts
      mediaType: text/typescript
      required: true
    - name: unit-test
      kind: test
      path: workers/repository-task-ts/test/repository-task-worker-component.test.ts
      mediaType: text/typescript
      required: true
verificationProfile: factory-floor
resourceBounds:
  maxFiles: 3
  maxPatchBytes: 131072
  maxVerificationSeconds: 600
requestedCapabilities:
  - repository.read
  - repository.proposePatch
  - verification.request
completionCriteria:
  - The worker component descriptor is publicly exported.
  - The generated unit test passes.
  - The retained patch and verification evidence agree.
---

Add the retained repository-task worker component descriptor through Factory Floor itself.
`;
}

function repositoryProfile() {
  return {
    schemaVersion: 1,
    repository: {
      owner: 'laurajoyhutchins',
      name: 'factory-floor',
    },
    pathBoundaries: ['workers/repository-task-ts/**'],
    recipes: { 'typescript-module': ['1'] },
    verificationProfiles: ['factory-floor'],
    packages: [
      {
        name: '@factory-floor/repository-task-worker',
        path: 'workers/repository-task-ts',
        sourceDirectory: 'src',
        testDirectory: 'test',
        publicExportPath: 'src/index.ts',
      },
    ],
  };
}

function duplicateKeys(
  rows: readonly Record<string, unknown>[],
  key: (row: Record<string, unknown>) => string,
): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = key(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as any) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function runState(
  db: ReturnType<typeof createDatabase>,
  correlationId: string,
) {
  const executions = await db
    .selectFrom('executions as execution')
    .innerJoin('deliveries as delivery', 'delivery.id', 'execution.delivery_id')
    .selectAll('execution')
    .where('delivery.correlation_id', '=', correlationId)
    .execute();
  const attempts = await db
    .selectFrom('execution_attempts as attempt')
    .innerJoin(
      'executions as execution',
      'execution.id',
      'attempt.execution_id',
    )
    .innerJoin('deliveries as delivery', 'delivery.id', 'execution.delivery_id')
    .select([
      'attempt.id',
      'attempt.execution_id',
      'attempt.attempt_number',
      'attempt.status',
      'attempt.failure',
    ])
    .where('delivery.correlation_id', '=', correlationId)
    .execute();
  const outputs = await db
    .selectFrom('execution_outputs as output')
    .innerJoin('executions as execution', 'execution.id', 'output.execution_id')
    .innerJoin('deliveries as delivery', 'delivery.id', 'execution.delivery_id')
    .innerJoin('artifacts as artifact', 'artifact.id', 'output.artifact_id')
    .select([
      'output.id',
      'output.execution_id',
      'output.attempt_id',
      'output.port_name',
      'artifact.digest',
      'artifact.size_bytes',
      'artifact.media_type',
    ])
    .where('delivery.correlation_id', '=', correlationId)
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
    .where('delivery.correlation_id', '=', correlationId)
    .execute();
  return { executions, attempts, outputs, deliveries };
}

async function waitForRun(
  db: ReturnType<typeof createDatabase>,
  correlationId: string,
): Promise<Awaited<ReturnType<typeof runState>>> {
  const deadline = Date.now() + 900_000;
  for (;;) {
    const state = await runState(db, correlationId);
    const completed =
      state.executions.length === 1 &&
      state.executions[0]?.status === 'completed' &&
      state.outputs.length === outputPorts.length &&
      state.deliveries.every((delivery) => delivery.status === 'completed');
    if (completed) return state;
    if (Date.now() > deadline) {
      throw new Error(
        `repository-task run timed out: ${JSON.stringify({
          correlationId,
          executions: state.executions,
          attempts: state.attempts,
          outputs: state.outputs.map((output) => output.port_name),
          deliveries: state.deliveries,
        })}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function readCommittedJson(
  blobStore: FilesystemArtifactBlobStore,
  digest: string,
): Promise<any> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return JSON.parse(
        await streamText(await blobStore.readCommitted(digest)),
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== 'not_found' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function outputArtifacts(
  blobStore: FilesystemArtifactBlobStore,
  state: Awaited<ReturnType<typeof runState>>,
): Promise<Record<string, any>> {
  return Object.fromEntries(
    await Promise.all(
      state.outputs.map(async (output) => [
        output.port_name,
        await readCommittedJson(blobStore, output.digest),
      ]),
    ),
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(outputRoot, path, '..'), { recursive: true });
  await writeFile(
    join(outputRoot, path),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

async function retainRun(
  name: string,
  state: Awaited<ReturnType<typeof runState>>,
  artifacts: Record<string, any>,
): Promise<void> {
  await writeJson(`${name}/state.json`, {
    executions: state.executions,
    attempts: state.attempts,
    outputs: state.outputs,
    deliveries: state.deliveries,
  });
  for (const port of outputPorts) {
    await writeJson(`${name}/${port}.json`, artifacts[port]);
  }
  const patch = String(artifacts.patch?.patch ?? '');
  await writeFile(join(outputRoot, name, 'patch.diff'), patch, 'utf8');
}

async function main(): Promise<void> {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  console.log('Starting PostgreSQL and MinIO for repository-task dogfood...');
  execFileSync('docker', ['compose', 'up', '-d', 'postgres', 'minio'], {
    cwd: root,
    stdio: 'inherit',
  });
  await waitForPostgres();

  const db = createDatabase(databaseUrl);
  const blobStore = new FilesystemArtifactBlobStore(artifactRoot);
  const children: ChildProcess[] = [];
  let worker: ChildProcess | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const interrupt = () => void stop(children).finally(() => process.exit(130));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);

  try {
    const migration = await migrateToLatest(db);
    if (migration.error) throw migration.error;

    const registrations = new RegistrationService(db);
    for (const document of await documents(
      'examples/repository-task/declarations/schemas.yaml',
    )) {
      await registrations.registerArtifactSchema(document);
    }
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
    for (const document of await documents(
      'examples/repository-task/declarations/components.yaml',
    )) {
      await registrations.registerComponentDefinition(document);
    }
    for (const document of await documents(
      'examples/repository-task/repository-task-system.yaml',
    )) {
      if (document.kind === 'Template') {
        await registrations.registerTemplate(document);
      }
    }
    for (const document of await documents(
      'examples/repository-task/repository-task-system.yaml',
    )) {
      if (document.kind === 'System') {
        await new SystemApplicationService(db).apply(document);
      }
    }

    process.env.CONTROL_PLANE_PUBLIC_URL = baseUrl;
    app = await buildApp({
      database: db,
      artifactBlobStore: blobStore,
      workerAuthToken: token,
    });
    await app.listen({ host: '127.0.0.1', port });

    const workerEnv = {
      DATABASE_URL: databaseUrl,
      FACTORY_FLOOR_WORKER_BASE_URL: baseUrl,
      FACTORY_FLOOR_WORKER_TOKEN: token,
      FACTORY_FLOOR_SCHEMA_DIGESTS: JSON.stringify(schemaDigests),
      FACTORY_FLOOR_WORKER_CONCURRENCY: '1',
      FACTORY_FLOOR_WORKER_ID: 'repository-task-dogfood-worker',
      FACTORY_FLOOR_REPOSITORY_ROOT: rootPath,
    };
    const startWorker = () =>
      startProcess(
        'pnpm',
        ['--filter', '@factory-floor/repository-task-worker', 'dev'],
        workerEnv,
      );
    worker = startWorker();
    children.push(worker);

    const baseRevision = git('rev-parse', 'HEAD');
    const snapshot = await repositorySnapshot();
    const identity = repositoryIdentity(baseRevision, snapshot);
    const profile = repositoryProfile();
    const commandService = new CommandService(db);
    const successCommand = await commandService.submit({
      region: 'repository-task',
      commandType: 'repository-task.execute',
      source: { kind: 'dogfood' } as any,
      payload: {
        authoredPlanMarkdown: authoredPlan(baseRevision),
        repositoryProfile: profile,
        repositorySnapshot: snapshot,
        repositoryIdentity: identity,
      },
      idempotencyKey: `repository-task-success-${baseRevision}`,
    });
    if (successCommand.disposition !== 'accepted') {
      throw new Error(
        `success command was not accepted: ${successCommand.disposition}`,
      );
    }
    const successState = await waitForRun(db, successCommand.correlationId);
    const successArtifacts = await outputArtifacts(blobStore, successState);
    const successPatch = String(successArtifacts.patch?.patch ?? '');
    const successEvidence = successArtifacts.evidence;
    const successDisposition = successArtifacts.disposition;
    if (
      successDisposition?.status !== 'succeeded' ||
      successEvidence?.status !== 'succeeded' ||
      successArtifacts.diagnostics?.length !== 0
    ) {
      throw new Error(
        `successful dogfood disposition was not successful: ${JSON.stringify(successDisposition)}`,
      );
    }
    if (
      sha256(successPatch) !== successArtifacts.patch.patchDigest ||
      successArtifacts.patch.patchDigest !== successEvidence.patchDigest
    ) {
      throw new Error('retained patch digest does not match retained evidence');
    }
    if (
      successEvidence.repositoryIdentity?.beforeExecution?.baseRevision !==
        baseRevision ||
      successEvidence.repositoryIdentity?.afterExecution?.baseRevision !==
        baseRevision
    ) {
      throw new Error(
        'retained evidence does not match submitted repository identity',
      );
    }
    if (
      !Array.isArray(successEvidence.verification) ||
      !successEvidence.verification.every(
        (stage: any) => stage.status === 'succeeded',
      )
    ) {
      throw new Error('trusted verification did not fully succeed');
    }
    const duplicateSuccessOutputs = duplicateKeys(
      successState.outputs as unknown as Record<string, unknown>[],
      (row) => `${String(row.execution_id)}:${String(row.port_name)}`,
    );
    if (duplicateSuccessOutputs.length > 0) {
      throw new Error(
        `duplicate successful outputs: ${duplicateSuccessOutputs.join(',')}`,
      );
    }
    await retainRun('success', successState, successArtifacts);

    const outputIdentityBeforeRestart = successState.outputs
      .map((output) => `${output.port_name}:${output.digest}`)
      .sort();
    await stop([worker]);
    children.splice(children.indexOf(worker), 1);
    worker = startWorker();
    children.push(worker);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const afterRestart = await runState(db, successCommand.correlationId);
    const outputIdentityAfterRestart = afterRestart.outputs
      .map((output) => `${output.port_name}:${output.digest}`)
      .sort();
    if (
      JSON.stringify(outputIdentityAfterRestart) !==
      JSON.stringify(outputIdentityBeforeRestart)
    ) {
      throw new Error('worker restart changed retained successful outputs');
    }

    const unavailableRevision = 'f'.repeat(40);
    const failureCommand = await commandService.submit({
      region: 'repository-task',
      commandType: 'repository-task.execute',
      source: { kind: 'dogfood' } as any,
      payload: {
        authoredPlanMarkdown: authoredPlan(unavailableRevision),
        repositoryProfile: profile,
        repositorySnapshot: snapshot,
        repositoryIdentity: repositoryIdentity(unavailableRevision, snapshot),
      },
      idempotencyKey: `repository-task-failure-${baseRevision}`,
    });
    if (failureCommand.disposition !== 'accepted') {
      throw new Error(
        `failure command was not accepted: ${failureCommand.disposition}`,
      );
    }
    const failureState = await waitForRun(db, failureCommand.correlationId);
    const failureArtifacts = await outputArtifacts(blobStore, failureState);
    const failureCode =
      failureArtifacts.disposition?.diagnostics?.[0]?.code ??
      failureArtifacts.evidence?.diagnostics?.[0]?.code;
    if (
      failureArtifacts.disposition?.status !== 'failed' ||
      failureCode !== 'worker.repository-identity-mismatch'
    ) {
      throw new Error(
        `deliberate failure was not retained correctly: ${JSON.stringify(failureArtifacts.disposition)}`,
      );
    }
    const duplicateFailureOutputs = duplicateKeys(
      failureState.outputs as unknown as Record<string, unknown>[],
      (row) => `${String(row.execution_id)}:${String(row.port_name)}`,
    );
    if (duplicateFailureOutputs.length > 0) {
      throw new Error(
        `duplicate failure outputs: ${duplicateFailureOutputs.join(',')}`,
      );
    }
    await retainRun('failure', failureState, failureArtifacts);

    const summary = {
      status: 'completed',
      baseRevision,
      successfulRun: {
        commandId: successCommand.commandId,
        correlationId: successCommand.correlationId,
        executionId: successState.executions[0]?.id,
        attemptIds: successState.attempts.map((attempt) => attempt.id),
        evidenceId: successEvidence.evidenceId,
        graphDigest: successArtifacts['generation-graph']?.graphDigest,
        patchDigest: successEvidence.patchDigest,
        treeDigest: successEvidence.treeDigest,
        mutationPaths: successEvidence.mutations.map(
          (mutation: any) => mutation.path,
        ),
        verification: successEvidence.verification.map((stage: any) => ({
          stageId: stage.stageId,
          status: stage.status,
          exitCode: stage.exitCode,
        })),
        outputIdentity: outputIdentityBeforeRestart,
        duplicateOutputs: duplicateSuccessOutputs,
      },
      restart: {
        preservedOutputIdentity: true,
        outputIdentity: outputIdentityAfterRestart,
      },
      deliberateFailure: {
        commandId: failureCommand.commandId,
        correlationId: failureCommand.correlationId,
        executionId: failureState.executions[0]?.id,
        attemptIds: failureState.attempts.map((attempt) => attempt.id),
        evidenceId: failureArtifacts.evidence?.evidenceId,
        diagnosticCode: failureCode,
        duplicateOutputs: duplicateFailureOutputs,
      },
    };
    await writeJson('summary.json', summary);
    console.log(JSON.stringify(summary, null, 2));
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
