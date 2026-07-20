import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalJsonDigest } from '../declarations/canonical-json.js';

export interface RepositoryTaskRepositoryIdentity {
  owner: string;
  name: string;
  baseRevision: string;
}

export interface RepositoryTaskNormalizedPlan extends Record<string, unknown> {
  planDigest: string;
  repository: RepositoryTaskRepositoryIdentity;
  allowedPaths: string[];
  recipe: { name: string; version: string; inputs?: Record<string, unknown> };
  outputs: Array<{
    name: string;
    kind: string;
    path: string;
    mediaType: string;
    required: boolean;
  }>;
  verificationProfile: string;
  resourceBounds: {
    maxFiles: number;
    maxPatchBytes: number;
    maxVerificationSeconds: number;
  };
}

export interface RepositoryTaskRepositoryProfile extends Record<
  string,
  unknown
> {
  repository: { owner: string; name: string };
  pathBoundaries: string[];
  recipes: Record<string, string[]>;
  verificationProfiles: string[];
}

export interface RepositoryTaskGenerationGraph extends Record<string, unknown> {
  graphDigest: string;
  planDigest: string;
  profileDigest: string;
  repository: RepositoryTaskRepositoryIdentity;
  recipe: { name: string; version: string };
  verificationProfile: string;
  nodes: Array<Record<string, unknown>>;
  outputs: Array<Record<string, unknown>>;
  conflicts: unknown[];
}

export interface RepositoryTaskVerificationStagePolicy {
  id: string;
  executable: string;
  args: string[];
  timeoutMs: number;
}

export interface RepositoryTaskVerificationProfilePolicy {
  stages: RepositoryTaskVerificationStagePolicy[];
}

export type RepositoryTaskVerificationProfiles = Record<
  string,
  RepositoryTaskVerificationProfilePolicy
>;

export interface RepositoryTaskExecutionInput {
  repositoryRoot: string;
  normalizedPlan: RepositoryTaskNormalizedPlan;
  repositoryProfile: RepositoryTaskRepositoryProfile;
  generationGraph: RepositoryTaskGenerationGraph;
  verificationProfiles: RepositoryTaskVerificationProfiles;
  dryRun?: boolean;
  maxLogBytes?: number;
}

export interface RepositoryTaskDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface RepositoryTaskMutationEvidence {
  id: string;
  operation: 'create' | 'update' | 'delete';
  path: string;
  contentDigest?: string;
  expectedDigest?: string;
}

export interface RepositoryTaskVerificationEvidence {
  stageId: string;
  executable: string;
  args: string[];
  status: 'not-run' | 'succeeded' | 'failed' | 'timed-out';
  exitCode?: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface RepositoryTaskEvidenceManifest {
  schemaVersion: 1;
  evidenceId: string;
  status: 'dry-run' | 'succeeded' | 'failed';
  baseRevision: string;
  planDigest: string;
  profileDigest: string;
  graphDigest: string;
  recipe: { name: string; version: string };
  verificationProfile: string;
  mutations: RepositoryTaskMutationEvidence[];
  verification: RepositoryTaskVerificationEvidence[];
  patchDigest: string | null;
  treeDigest: string | null;
  diagnostics: RepositoryTaskDiagnostic[];
  resources: {
    files: number;
    contentBytes: number;
    patchBytes: number;
    verificationMs: number;
    totalDurationMs: number;
  };
}

export interface RepositoryTaskExecutionResult {
  status: 'dry-run' | 'succeeded' | 'failed';
  patch: string;
  evidence: RepositoryTaskEvidenceManifest;
}

interface FileOperation {
  id: string;
  operation: 'create' | 'update' | 'delete';
  path: string;
  content?: string;
  contentDigest?: string;
  expectedDigest?: string;
}

interface StageProcessResult {
  status: 'succeeded' | 'failed' | 'timed-out';
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

class ExecutionFailure extends Error {
  constructor(
    readonly diagnostic: RepositoryTaskDiagnostic,
    readonly verification: RepositoryTaskVerificationEvidence[] = [],
    readonly patch = '',
    readonly patchDigest: string | null = null,
    readonly treeDigest: string | null = null,
  ) {
    super(diagnostic.message);
    this.name = 'ExecutionFailure';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function withoutKey(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function fail(code: string, message: string, path?: string): never {
  throw new ExecutionFailure({ code, message, ...(path ? { path } : {}) });
}

function safePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return !value.split('/').some((segment) => {
    return (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment === '.git'
    );
  });
}

function pathMatches(path: string, constraint: string): boolean {
  if (constraint.endsWith('/**')) {
    const prefix = constraint.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === constraint;
}

function repositoryMatches(
  left: { owner: string; name: string },
  right: { owner: string; name: string },
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
}

function validateIdentity(input: RepositoryTaskExecutionInput): void {
  const plan = input.normalizedPlan;
  const graph = input.generationGraph;
  const profile = input.repositoryProfile;
  const computedPlanDigest = canonicalJsonDigest(
    withoutKey(plan, 'planDigest'),
  );
  if (computedPlanDigest !== plan.planDigest) {
    fail(
      'executor.plan-digest-mismatch',
      'The normalized plan digest does not match its canonical content.',
    );
  }
  const computedProfileDigest = canonicalJsonDigest(profile);
  if (computedProfileDigest !== graph.profileDigest) {
    fail(
      'executor.profile-digest-mismatch',
      'The repository profile digest does not match the generation graph.',
    );
  }
  const computedGraphDigest = canonicalJsonDigest(
    withoutKey(graph, 'graphDigest'),
  );
  if (computedGraphDigest !== graph.graphDigest) {
    fail(
      'executor.graph-digest-mismatch',
      'The generation graph digest does not match its canonical content.',
    );
  }
  if (graph.planDigest !== plan.planDigest) {
    fail(
      'executor.plan-identity-mismatch',
      'The generation graph references a different normalized plan.',
    );
  }
  if (
    !repositoryMatches(plan.repository, graph.repository) ||
    !repositoryMatches(plan.repository, profile.repository) ||
    plan.repository.baseRevision !== graph.repository.baseRevision
  ) {
    fail(
      'executor.repository-identity-mismatch',
      'Plan, profile, and graph repository identities do not agree.',
    );
  }
  if (
    graph.recipe.name !== plan.recipe.name ||
    graph.recipe.version !== plan.recipe.version
  ) {
    fail(
      'executor.recipe-identity-mismatch',
      'The generation graph references a different recipe.',
    );
  }
  if (graph.verificationProfile !== plan.verificationProfile) {
    fail(
      'executor.verification-identity-mismatch',
      'The generation graph references a different verification profile.',
    );
  }
  if (graph.conflicts.length > 0) {
    fail(
      'executor.graph-conflicts',
      'A generation graph with unresolved conflicts cannot be applied.',
    );
  }
}

function verificationPolicy(
  input: RepositoryTaskExecutionInput,
): RepositoryTaskVerificationProfilePolicy {
  const name = input.normalizedPlan.verificationProfile;
  const policy = input.verificationProfiles[name];
  if (!input.repositoryProfile.verificationProfiles.includes(name) || !policy) {
    fail(
      'verification.profile-unavailable',
      `Verification profile ${name} is not available from trusted policy.`,
    );
  }
  if (!Array.isArray(policy.stages) || policy.stages.length === 0) {
    fail(
      'verification.profile-invalid',
      `Verification profile ${name} has no trusted stages.`,
    );
  }
  const ids = new Set<string>();
  for (const stage of policy.stages) {
    if (
      !isObject(stage) ||
      typeof stage.id !== 'string' ||
      stage.id.length === 0 ||
      typeof stage.executable !== 'string' ||
      stage.executable.length === 0 ||
      !Array.isArray(stage.args) ||
      !stage.args.every((argument) => typeof argument === 'string') ||
      !Number.isSafeInteger(stage.timeoutMs) ||
      stage.timeoutMs < 1 ||
      ids.has(stage.id)
    ) {
      fail(
        'verification.profile-invalid',
        `Verification profile ${name} contains an invalid stage.`,
      );
    }
    ids.add(stage.id);
  }
  return policy;
}

function fileOperations(input: RepositoryTaskExecutionInput): FileOperation[] {
  const plan = input.normalizedPlan;
  const profile = input.repositoryProfile;
  const outputPaths = new Map(
    plan.outputs.map((output) => [output.name, output.path]),
  );
  const paths = new Set<string>();
  const operations: FileOperation[] = [];
  for (const node of input.generationGraph.nodes) {
    if (node.kind !== 'file-operation') continue;
    const operation = node.operation;
    const path = node.path;
    const id = node.id;
    const outputName = node.outputName;
    if (
      typeof id !== 'string' ||
      !['create', 'update', 'delete'].includes(String(operation)) ||
      typeof path !== 'string' ||
      typeof outputName !== 'string'
    ) {
      fail(
        'executor.operation-invalid',
        'The generation graph contains an invalid file operation.',
      );
    }
    if (!safePath(path)) {
      fail('executor.path-unsafe', `Operation path ${path} is unsafe.`, path);
    }
    if (
      !plan.allowedPaths.some((constraint) => pathMatches(path, constraint))
    ) {
      fail(
        'executor.path-not-allowed',
        `Operation path ${path} is outside the authored plan boundaries.`,
        path,
      );
    }
    if (
      !profile.pathBoundaries.some((constraint) =>
        pathMatches(path, constraint),
      )
    ) {
      fail(
        'executor.path-outside-profile',
        `Operation path ${path} is outside the repository profile.`,
        path,
      );
    }
    if (outputPaths.get(outputName) !== path) {
      fail(
        'executor.output-mismatch',
        `Operation ${id} does not match its declared output.`,
        path,
      );
    }
    if (paths.has(path)) {
      fail(
        'executor.duplicate-path',
        `Multiple operations target ${path}.`,
        path,
      );
    }
    paths.add(path);
    const content = node.content;
    const contentDigest = node.contentDigest;
    const expectedDigest = node.expectedDigest;
    if (operation !== 'delete') {
      if (
        typeof content !== 'string' ||
        typeof contentDigest !== 'string' ||
        sha256(content) !== contentDigest
      ) {
        fail(
          'executor.content-digest-mismatch',
          `Operation ${id} has invalid retained content.`,
          path,
        );
      }
    }
    if (
      operation !== 'create' &&
      (typeof expectedDigest !== 'string' || expectedDigest.length !== 64)
    ) {
      fail(
        'executor.expected-digest-missing',
        `Operation ${id} must identify the bytes it expects to replace.`,
        path,
      );
    }
    operations.push({
      id,
      operation: operation as FileOperation['operation'],
      path,
      ...(typeof content === 'string' ? { content } : {}),
      ...(typeof contentDigest === 'string' ? { contentDigest } : {}),
      ...(typeof expectedDigest === 'string' ? { expectedDigest } : {}),
    });
  }
  if (operations.length > plan.resourceBounds.maxFiles) {
    fail(
      'executor.max-files-exceeded',
      'The generation graph exceeds the plan file limit.',
    );
  }
  const contentBytes = operations.reduce((total, operation) => {
    return total + Buffer.byteLength(operation.content ?? '', 'utf8');
  }, 0);
  if (contentBytes > plan.resourceBounds.maxPatchBytes) {
    fail(
      'executor.max-patch-bytes-exceeded',
      'The retained operation content exceeds the plan patch limit.',
    );
  }
  return operations;
}

async function runGit(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: trustedEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 || allowFailure) resolve(stdout.trimEnd());
      else reject(new Error(stderr.trim() || `git exited with ${code}`));
    });
  });
}

function trustedEnvironment(): NodeJS.ProcessEnv {
  const names = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TMPDIR',
    'TEMP',
    'TMP',
    'CI',
    'NODE_ENV',
    'PNPM_HOME',
    'COREPACK_HOME',
    'UV_CACHE_DIR',
  ];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

async function rejectSymlinks(root: string, path: string): Promise<void> {
  const segments = path.split('/');
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        fail(
          'executor.symlink-path',
          `Operation path ${path} traverses a symbolic link.`,
          path,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
  }
}

async function preflight(
  root: string,
  operations: FileOperation[],
): Promise<void> {
  for (const operation of operations) {
    await rejectSymlinks(root, operation.path);
    const absolute = join(root, operation.path);
    let bytes: string | undefined;
    try {
      const stat = await lstat(absolute);
      if (!stat.isFile()) {
        fail(
          'executor.target-not-file',
          `Operation target ${operation.path} is not a regular file.`,
          operation.path,
        );
      }
      bytes = await readFile(absolute, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (operation.operation === 'create' && bytes !== undefined) {
      fail(
        'executor.create-conflict',
        `Create target ${operation.path} already exists.`,
        operation.path,
      );
    }
    if (operation.operation !== 'create') {
      if (bytes === undefined || sha256(bytes) !== operation.expectedDigest) {
        fail(
          'executor.mutation-conflict',
          `Target ${operation.path} does not match the reviewed bytes.`,
          operation.path,
        );
      }
    }
  }
}

async function applyOperations(
  root: string,
  operations: FileOperation[],
): Promise<void> {
  for (const operation of operations) {
    const absolute = join(root, operation.path);
    if (operation.operation === 'delete') {
      await unlink(absolute);
      continue;
    }
    await mkdir(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.factory-floor-${operation.contentDigest}.tmp`;
    await writeFile(temporary, operation.content ?? '', {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, absolute);
  }
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s]+/gi,
      '$1=[REDACTED]',
    );
}

function boundedLog(value: string, maxBytes: number): string {
  const redacted = redact(value);
  const buffer = Buffer.from(redacted, 'utf8');
  if (buffer.length <= maxBytes) return redacted;
  return buffer.subarray(0, maxBytes).toString('utf8');
}

async function runStage(
  stage: RepositoryTaskVerificationStagePolicy,
  cwd: string,
  timeoutMs: number,
  maxLogBytes: number,
): Promise<StageProcessResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(stage.executable, stage.args, {
      cwd,
      env: trustedEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < maxLogBytes * 4) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < maxLogBytes * 4) stderr += chunk;
    });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: timedOut
          ? 'timed-out'
          : exitCode === 0
            ? 'succeeded'
            : 'failed',
        exitCode,
        durationMs: Date.now() - started,
        stdout: boundedLog(stdout, maxLogBytes),
        stderr: boundedLog(stderr, maxLogBytes),
      });
    };
    child.once('error', (error) => {
      stderr += error.message;
      finish(null);
    });
    child.once('close', finish);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
  });
}

function mutationEvidence(
  operations: FileOperation[],
): RepositoryTaskMutationEvidence[] {
  return operations.map((operation) => ({
    id: operation.id,
    operation: operation.operation,
    path: operation.path,
    ...(operation.contentDigest
      ? { contentDigest: operation.contentDigest }
      : {}),
    ...(operation.expectedDigest
      ? { expectedDigest: operation.expectedDigest }
      : {}),
  }));
}

function evidenceId(
  input: RepositoryTaskExecutionInput,
  status: RepositoryTaskEvidenceManifest['status'],
  mutations: RepositoryTaskMutationEvidence[],
  verification: RepositoryTaskVerificationEvidence[],
  patchDigest: string | null,
  treeDigest: string | null,
  diagnostics: RepositoryTaskDiagnostic[],
): string {
  return canonicalJsonDigest({
    schemaVersion: 1,
    status,
    baseRevision: input.normalizedPlan.repository.baseRevision,
    planDigest: input.normalizedPlan.planDigest,
    profileDigest: input.generationGraph.profileDigest,
    graphDigest: input.generationGraph.graphDigest,
    recipe: input.generationGraph.recipe,
    verificationProfile: input.normalizedPlan.verificationProfile,
    mutations,
    verification: verification.map((stage) => ({
      stageId: stage.stageId,
      executable: stage.executable,
      args: stage.args,
      status: stage.status,
      exitCode: stage.exitCode ?? null,
      stdoutDigest: sha256(stage.stdout),
      stderrDigest: sha256(stage.stderr),
    })),
    patchDigest,
    treeDigest,
    diagnostics,
  });
}

function manifest(
  input: RepositoryTaskExecutionInput,
  status: RepositoryTaskEvidenceManifest['status'],
  operations: FileOperation[],
  verification: RepositoryTaskVerificationEvidence[],
  patch: string,
  patchDigest: string | null,
  treeDigest: string | null,
  diagnostics: RepositoryTaskDiagnostic[],
  started: number,
): RepositoryTaskEvidenceManifest {
  const mutations = mutationEvidence(operations);
  const contentBytes = operations.reduce((total, operation) => {
    return total + Buffer.byteLength(operation.content ?? '', 'utf8');
  }, 0);
  const verificationMs = verification.reduce((total, stage) => {
    return total + stage.durationMs;
  }, 0);
  return {
    schemaVersion: 1,
    evidenceId: evidenceId(
      input,
      status,
      mutations,
      verification,
      patchDigest,
      treeDigest,
      diagnostics,
    ),
    status,
    baseRevision: input.normalizedPlan.repository.baseRevision,
    planDigest: input.normalizedPlan.planDigest,
    profileDigest: input.generationGraph.profileDigest,
    graphDigest: input.generationGraph.graphDigest,
    recipe: input.generationGraph.recipe,
    verificationProfile: input.normalizedPlan.verificationProfile,
    mutations,
    verification,
    patchDigest,
    treeDigest,
    diagnostics,
    resources: {
      files: operations.length,
      contentBytes,
      patchBytes: Buffer.byteLength(patch, 'utf8'),
      verificationMs,
      totalDurationMs: Date.now() - started,
    },
  };
}

export async function executeRepositoryTaskGraph(
  input: RepositoryTaskExecutionInput,
): Promise<RepositoryTaskExecutionResult> {
  const started = Date.now();
  let operations: FileOperation[] = [];
  let worktreeParent: string | undefined;
  let worktree: string | undefined;
  let registeredWorktree = false;
  try {
    validateIdentity(input);
    const policy = verificationPolicy(input);
    operations = fileOperations(input);
    try {
      await runGit(input.repositoryRoot, [
        'cat-file',
        '-e',
        `${input.normalizedPlan.repository.baseRevision}^{commit}`,
      ]);
    } catch {
      fail(
        'executor.base-unavailable',
        `Base revision ${input.normalizedPlan.repository.baseRevision} is unavailable.`,
      );
    }
    worktreeParent = await mkdtemp(join(tmpdir(), 'factory-floor-apply-'));
    worktree = join(worktreeParent, 'worktree');
    await runGit(input.repositoryRoot, [
      'worktree',
      'add',
      '--detach',
      worktree,
      input.normalizedPlan.repository.baseRevision,
    ]);
    registeredWorktree = true;
    await preflight(worktree, operations);
    if (input.dryRun) {
      const verification = policy.stages.map((stage) => ({
        stageId: stage.id,
        executable: stage.executable,
        args: [...stage.args],
        status: 'not-run' as const,
        durationMs: 0,
        stdout: '',
        stderr: '',
      }));
      return {
        status: 'dry-run',
        patch: '',
        evidence: manifest(
          input,
          'dry-run',
          operations,
          verification,
          '',
          null,
          null,
          [],
          started,
        ),
      };
    }
    await applyOperations(worktree, operations);
    await runGit(worktree, ['add', '-A']);
    const patch = await runGit(worktree, [
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      '--no-ext-diff',
    ]);
    const patchBytes = Buffer.byteLength(patch, 'utf8');
    if (patchBytes > input.normalizedPlan.resourceBounds.maxPatchBytes) {
      fail(
        'executor.max-patch-bytes-exceeded',
        'The resulting patch exceeds the authored plan limit.',
      );
    }
    const patchDigest = sha256(patch);
    const treeDigest = await runGit(worktree, ['write-tree']);
    const verification: RepositoryTaskVerificationEvidence[] = [];
    const deadline =
      started +
      input.normalizedPlan.resourceBounds.maxVerificationSeconds * 1_000;
    const maxLogBytes = Math.max(1, input.maxLogBytes ?? 64 * 1_024);
    for (const stage of policy.stages) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ExecutionFailure(
          {
            code: 'verification.timeout',
            message: 'The repository-task verification budget was exhausted.',
          },
          verification,
          patch,
          patchDigest,
          treeDigest,
        );
      }
      const result = await runStage(
        stage,
        worktree,
        Math.min(stage.timeoutMs, remaining),
        maxLogBytes,
      );
      const stageEvidence: RepositoryTaskVerificationEvidence = {
        stageId: stage.id,
        executable: stage.executable,
        args: [...stage.args],
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      verification.push(stageEvidence);
      if (result.status !== 'succeeded') {
        throw new ExecutionFailure(
          {
            code:
              result.status === 'timed-out'
                ? 'verification.timeout'
                : 'verification.failed',
            message:
              result.status === 'timed-out'
                ? `Verification stage ${stage.id} timed out.`
                : `Verification stage ${stage.id} failed.`,
          },
          verification,
          patch,
          patchDigest,
          treeDigest,
        );
      }
    }
    return {
      status: 'succeeded',
      patch,
      evidence: manifest(
        input,
        'succeeded',
        operations,
        verification,
        patch,
        patchDigest,
        treeDigest,
        [],
        started,
      ),
    };
  } catch (error) {
    const failure =
      error instanceof ExecutionFailure
        ? error
        : new ExecutionFailure({
            code: 'executor.unexpected-failure',
            message: error instanceof Error ? error.message : String(error),
          });
    return {
      status: 'failed',
      patch: failure.patch,
      evidence: manifest(
        input,
        'failed',
        operations,
        failure.verification,
        failure.patch,
        failure.patchDigest,
        failure.treeDigest,
        [failure.diagnostic],
        started,
      ),
    };
  } finally {
    if (registeredWorktree && worktree) {
      await runGit(
        input.repositoryRoot,
        ['worktree', 'remove', '--force', worktree],
        true,
      ).catch(() => undefined);
    }
    if (worktreeParent) {
      await rm(worktreeParent, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}
