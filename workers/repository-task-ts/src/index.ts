import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  executeRepositoryTaskGraph,
  type RepositoryTaskExecutionInput,
  type RepositoryTaskExecutionResult,
  type RepositoryTaskGenerationGraph,
  type RepositoryTaskNormalizedPlan,
  type RepositoryTaskRepositoryProfile,
  type RepositoryTaskVerificationProfiles,
} from '@factory-floor/runtime-core';
import {
  ComponentRegistry,
  WorkerProtocolClient,
  WorkerRunner,
  emptyResourceUsage,
  type WorkerComponent,
  type WorkerExecutionContext,
} from '@factory-floor/worker-sdk-ts';
import type {
  ProposedResult,
  StagedArtifact,
} from '@factory-floor/contracts-ts';

const repositoryTaskSchemaKeys = [
  'repository-task-authored-plan.v1',
  'repository-task-normalized-plan.v1',
  'repository-task-generation-graph.v1',
  'repository-task-patch.v1',
  'repository-task-evidence.v1',
  'repository-task-diagnostics.v1',
  'repository-task-disposition.v1',
] as const;

export type RepositoryTaskSchemaKey = (typeof repositoryTaskSchemaKeys)[number];

export type RepositoryTaskArtifactSchemaMetadata = Record<string, unknown> & {
  schemaId: string;
  schemaDigest: string;
};

export type RepositoryTaskSchemaMetadata = Record<
  RepositoryTaskSchemaKey,
  RepositoryTaskArtifactSchemaMetadata
>;

export interface RepositoryTaskRepositoryIdentity {
  repository: {
    owner: string;
    name: string;
  };
  baseRevision: string;
  snapshotDigest: string;
  dirtyStatePolicy: 'require-clean';
}

export type RepositoryTaskIdentityValidationPhase =
  | 'before-execution'
  | 'after-execution';

export interface ValidatedRepositoryTaskIdentity
  extends RepositoryTaskRepositoryIdentity {
  phase: RepositoryTaskIdentityValidationPhase;
  observedHeadRevision: string;
  observedDirtyState: 'clean';
}

export interface RepositoryTaskIdentityValidationInput {
  repositoryRoot: string;
  identity: RepositoryTaskRepositoryIdentity;
  repositorySnapshot: { files: Record<string, string> };
  repositoryProfile: RepositoryTaskRepositoryProfile;
  normalizedPlan: RepositoryTaskNormalizedPlan;
  phase: RepositoryTaskIdentityValidationPhase;
}

export interface RepositoryTaskIdentityValidator {
  validate(
    input: RepositoryTaskIdentityValidationInput,
  ): Promise<ValidatedRepositoryTaskIdentity>;
}

export interface RepositoryTaskDiagnostic {
  code: string;
  severity?: string;
  path?: string;
  message: string;
}

export interface RepositoryTaskCompilerInput {
  authoredPlanMarkdown: string;
  repositoryProfile: RepositoryTaskRepositoryProfile;
  repositorySnapshot: { files: Record<string, string> };
  repositoryIdentity: RepositoryTaskRepositoryIdentity;
}

export interface RepositoryTaskCompilerResult {
  authoredPlan: Record<string, unknown> | null;
  normalizedPlan: RepositoryTaskNormalizedPlan | null;
  generationGraph: RepositoryTaskGenerationGraph | null;
  diagnostics: RepositoryTaskDiagnostic[];
}

export interface RepositoryTaskCompiler {
  compile(
    input: RepositoryTaskCompilerInput,
  ): Promise<RepositoryTaskCompilerResult>;
}

export interface RepositoryTaskExecutor {
  execute(
    input: RepositoryTaskExecutionInput,
  ): Promise<RepositoryTaskExecutionResult>;
}

export interface RepositoryTaskWorkerDependencies {
  repositoryRoot: string;
  verificationProfiles: RepositoryTaskVerificationProfiles;
  schemaMetadata: RepositoryTaskSchemaMetadata;
  identityValidator?: RepositoryTaskIdentityValidator;
  compiler?: RepositoryTaskCompiler;
  executor?: RepositoryTaskExecutor;
}

interface CompilerModules {
  parseRepositoryTaskPlanMarkdown(markdown: string): {
    authoredPlan: Record<string, unknown> | null;
    diagnostics: RepositoryTaskDiagnostic[];
  };
  normalizeRepositoryTaskPlan(value: Record<string, unknown>): {
    normalizedPlan: RepositoryTaskNormalizedPlan | null;
    diagnostics: RepositoryTaskDiagnostic[];
  };
  compileTypescriptModuleRecipePlan(
    markdown: string,
    options: {
      profile: RepositoryTaskRepositoryProfile;
      repositorySnapshot: { files: Record<string, string> };
    },
  ): {
    generationGraph: RepositoryTaskGenerationGraph | null;
    diagnostics: RepositoryTaskDiagnostic[];
  };
}

type RepositoryTaskPayload = RepositoryTaskCompilerInput;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function authoritativeSchemaMetadata(
  value: unknown,
): RepositoryTaskSchemaMetadata {
  if (!isObject(value)) {
    throw new Error('FACTORY_FLOOR_SCHEMA_DIGESTS must be a JSON object');
  }
  const result = {} as RepositoryTaskSchemaMetadata;
  for (const schemaKey of repositoryTaskSchemaKeys) {
    const schema = value[schemaKey];
    if (
      !isObject(schema) ||
      typeof schema.id !== 'string' ||
      schema.id.length === 0 ||
      !isDigest(schema.digest)
    ) {
      throw new Error(
        `FACTORY_FLOOR_SCHEMA_DIGESTS is missing authoritative metadata for ${schemaKey}`,
      );
    }
    result[schemaKey] = {
      schemaId: schema.id,
      schemaDigest: schema.digest,
    };
  }
  return result;
}

function validateInjectedSchemaMetadata(
  value: RepositoryTaskSchemaMetadata,
): RepositoryTaskSchemaMetadata {
  const registrationShape = Object.fromEntries(
    repositoryTaskSchemaKeys.map((key) => [
      key,
      {
        id: value[key]?.schemaId,
        digest: value[key]?.schemaDigest,
      },
    ]),
  );
  return authoritativeSchemaMetadata(registrationShape);
}

export function repositoryTaskSchemaMetadataFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RepositoryTaskSchemaMetadata {
  const raw = required(env, 'FACTORY_FLOOR_SCHEMA_DIGESTS');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `FACTORY_FLOOR_SCHEMA_DIGESTS must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return authoritativeSchemaMetadata(parsed);
}

export function repositoryTaskSnapshotDigest(snapshot: {
  files: Record<string, string>;
}): string {
  const canonicalFiles = Object.keys(snapshot.files)
    .sort()
    .map((path) => [path, snapshot.files[path]] as const);
  return createHash('sha256')
    .update(JSON.stringify(canonicalFiles), 'utf8')
    .digest('hex');
}

function repositoryIdentityDiagnostic(error: unknown): RepositoryTaskDiagnostic {
  return {
    code: 'worker.repository-identity-mismatch',
    severity: 'error',
    path: '/inputs/task/repositoryIdentity',
    message: error instanceof Error ? error.message : String(error),
  };
}

function assertIdentityMatchesInvocation(
  input: RepositoryTaskIdentityValidationInput,
): void {
  const { identity, repositoryProfile, normalizedPlan, repositorySnapshot } =
    input;
  if (
    identity.repository.owner !== repositoryProfile.repository.owner ||
    identity.repository.name !== repositoryProfile.repository.name ||
    identity.repository.owner !== normalizedPlan.repository.owner ||
    identity.repository.name !== normalizedPlan.repository.name
  ) {
    throw new Error(
      'Repository identity does not match the repository profile and normalized plan.',
    );
  }
  if (identity.baseRevision !== normalizedPlan.repository.baseRevision) {
    throw new Error(
      'Repository base revision does not match the normalized plan base revision.',
    );
  }
  const observedSnapshotDigest = repositoryTaskSnapshotDigest(repositorySnapshot);
  if (identity.snapshotDigest !== observedSnapshotDigest) {
    throw new Error(
      `Repository snapshot digest mismatch: expected ${identity.snapshotDigest}, observed ${observedSnapshotDigest}.`,
    );
  }
  if (identity.dirtyStatePolicy !== 'require-clean') {
    throw new Error('Repository dirty-state policy must require a clean worktree.');
  }
}

export function createRepositoryTaskIdentityValidator(): RepositoryTaskIdentityValidator {
  return {
    async validate(input) {
      assertIdentityMatchesInvocation(input);
      const observedHeadRevision = execFileSync(
        'git',
        ['-C', input.repositoryRoot, 'rev-parse', 'HEAD'],
        { encoding: 'utf8' },
      ).trim();
      if (observedHeadRevision !== input.identity.baseRevision) {
        throw new Error(
          `Repository HEAD mismatch: expected ${input.identity.baseRevision}, observed ${observedHeadRevision}.`,
        );
      }
      const status = execFileSync(
        'git',
        [
          '-C',
          input.repositoryRoot,
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
        ],
        { encoding: 'utf8' },
      ).trim();
      if (status.length > 0) {
        throw new Error('Repository worktree is not clean.');
      }
      return {
        ...input.identity,
        phase: input.phase,
        observedHeadRevision,
        observedDirtyState: 'clean',
      };
    },
  };
}

function completed(
  context: WorkerExecutionContext,
  artifacts: StagedArtifact[],
): ProposedResult {
  return {
    protocolVersion: '1.0',
    executionId: context.envelope.executionId,
    attemptId: context.envelope.attemptId,
    leaseToken: context.envelope.leaseToken,
    lifecycleEpoch: context.envelope.lifecycleEpoch,
    status: 'completed',
    stagedArtifacts: artifacts,
    proposedEvents: [],
    externalActionProposals: [],
    resourceUsage: emptyResourceUsage(),
  };
}

function invalidInput(message: string): RepositoryTaskCompilerResult {
  return {
    authoredPlan: null,
    normalizedPlan: null,
    generationGraph: null,
    diagnostics: [
      {
        code: 'worker.input-invalid',
        severity: 'error',
        path: '/inputs/task',
        message,
      },
    ],
  };
}

function isRepositoryIdentity(
  value: unknown,
): value is RepositoryTaskRepositoryIdentity {
  return (
    isObject(value) &&
    isObject(value.repository) &&
    typeof value.repository.owner === 'string' &&
    typeof value.repository.name === 'string' &&
    typeof value.baseRevision === 'string' &&
    isDigest(value.snapshotDigest) &&
    value.dirtyStatePolicy === 'require-clean'
  );
}

function payload(
  context: WorkerExecutionContext,
): RepositoryTaskPayload | null {
  const input = context.envelope.inputs.find(
    (candidate) => candidate.portName === 'task',
  )?.payload;
  if (!isObject(input)) return null;
  if (
    typeof input.authoredPlanMarkdown !== 'string' ||
    !isObject(input.repositoryProfile) ||
    !isObject(input.repositorySnapshot) ||
    !isObject(input.repositorySnapshot.files) ||
    !Object.values(input.repositorySnapshot.files).every(
      (value) => typeof value === 'string',
    ) ||
    !isRepositoryIdentity(input.repositoryIdentity)
  ) {
    return null;
  }
  return input as unknown as RepositoryTaskPayload;
}

async function loadCompilerModules(): Promise<CompilerModules> {
  const compileModuleUrl = new URL(
    '../../../scripts/compile-repository-task-plan.mjs',
    import.meta.url,
  ).href;
  const normalizeModuleUrl = new URL(
    '../../../scripts/normalize-repository-task-plan.mjs',
    import.meta.url,
  ).href;
  const recipeModuleUrl = new URL(
    '../../../scripts/compile-typescript-module-recipe-plan.mjs',
    import.meta.url,
  ).href;
  const [compileModule, normalizeModule, recipeModule] = await Promise.all([
    import(compileModuleUrl),
    import(normalizeModuleUrl),
    import(recipeModuleUrl),
  ]);
  return {
    parseRepositoryTaskPlanMarkdown:
      compileModule.parseRepositoryTaskPlanMarkdown as CompilerModules['parseRepositoryTaskPlanMarkdown'],
    normalizeRepositoryTaskPlan:
      normalizeModule.normalizeRepositoryTaskPlan as CompilerModules['normalizeRepositoryTaskPlan'],
    compileTypescriptModuleRecipePlan:
      recipeModule.compileTypescriptModuleRecipePlan as CompilerModules['compileTypescriptModuleRecipePlan'],
  };
}

export function createRepositoryTaskCompiler(): RepositoryTaskCompiler {
  return {
    async compile(input) {
      const modules = await loadCompilerModules();
      const parsed = modules.parseRepositoryTaskPlanMarkdown(
        input.authoredPlanMarkdown,
      );
      if (!parsed.authoredPlan || parsed.diagnostics.length > 0) {
        return {
          authoredPlan: parsed.authoredPlan,
          normalizedPlan: null,
          generationGraph: null,
          diagnostics: parsed.diagnostics,
        };
      }
      const normalized = modules.normalizeRepositoryTaskPlan(
        parsed.authoredPlan,
      );
      if (!normalized.normalizedPlan || normalized.diagnostics.length > 0) {
        return {
          authoredPlan: parsed.authoredPlan,
          normalizedPlan: normalized.normalizedPlan,
          generationGraph: null,
          diagnostics: normalized.diagnostics,
        };
      }
      const compiled = modules.compileTypescriptModuleRecipePlan(
        input.authoredPlanMarkdown,
        {
          profile: input.repositoryProfile,
          repositorySnapshot: input.repositorySnapshot,
        },
      );
      return {
        authoredPlan: parsed.authoredPlan,
        normalizedPlan: normalized.normalizedPlan,
        generationGraph: compiled.generationGraph,
        diagnostics: compiled.diagnostics,
      };
    },
  };
}

export function createRepositoryTaskExecutor(): RepositoryTaskExecutor {
  return { execute: executeRepositoryTaskGraph };
}

async function stageArtifacts(
  context: WorkerExecutionContext,
  schemaMetadata: RepositoryTaskSchemaMetadata,
  values: {
    authoredPlan: unknown;
    normalizedPlan: unknown;
    generationGraph: unknown;
    patch: unknown;
    evidence: unknown;
    diagnostics: unknown;
    disposition: unknown;
  },
): Promise<StagedArtifact[]> {
  const entries = [
    ['authored-plan', values.authoredPlan, 'repository-task-authored-plan.v1'],
    [
      'normalized-plan',
      values.normalizedPlan,
      'repository-task-normalized-plan.v1',
    ],
    [
      'generation-graph',
      values.generationGraph,
      'repository-task-generation-graph.v1',
    ],
    ['patch', values.patch, 'repository-task-patch.v1'],
    ['evidence', values.evidence, 'repository-task-evidence.v1'],
    ['diagnostics', values.diagnostics, 'repository-task-diagnostics.v1'],
    ['disposition', values.disposition, 'repository-task-disposition.v1'],
  ] as const;
  const artifacts: StagedArtifact[] = [];
  for (const [portName, value, schemaKey] of entries) {
    artifacts.push(
      await context.stageJson(portName, value, schemaMetadata[schemaKey]),
    );
  }
  return artifacts;
}

async function failedResult(
  context: WorkerExecutionContext,
  schemaMetadata: RepositoryTaskSchemaMetadata,
  task: RepositoryTaskPayload | null,
  compiled: RepositoryTaskCompilerResult,
  phase: 'compile' | 'verify',
  diagnostics: RepositoryTaskDiagnostic[],
  repositoryIdentity?: {
    beforeExecution?: ValidatedRepositoryTaskIdentity;
  },
): Promise<ProposedResult> {
  const disposition = {
    status: 'failed',
    phase,
    ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
    diagnostics,
  };
  const artifacts = await stageArtifacts(context, schemaMetadata, {
    authoredPlan: compiled.authoredPlan ?? {
      markdown: task?.authoredPlanMarkdown ?? null,
    },
    normalizedPlan: compiled.normalizedPlan,
    generationGraph: compiled.generationGraph,
    patch: { patch: '', patchDigest: null },
    evidence:
      repositoryIdentity === undefined
        ? null
        : { repositoryIdentity, diagnostics },
    diagnostics,
    disposition,
  });
  return completed(context, artifacts);
}

export function createRepositoryTaskComponent(
  dependencies: RepositoryTaskWorkerDependencies,
): WorkerComponent {
  const schemaMetadata = validateInjectedSchemaMetadata(
    dependencies.schemaMetadata,
  );
  const compiler = dependencies.compiler ?? createRepositoryTaskCompiler();
  const executor = dependencies.executor ?? createRepositoryTaskExecutor();
  const identityValidator =
    dependencies.identityValidator ?? createRepositoryTaskIdentityValidator();
  return async (context) => {
    const task = payload(context);
    const compiled = task
      ? await compiler.compile(task)
      : invalidInput(
          'The task input must include authoredPlanMarkdown, repositoryProfile, repositorySnapshot.files, and a fail-closed repositoryIdentity.',
        );
    if (
      !task ||
      compiled.diagnostics.length > 0 ||
      !compiled.authoredPlan ||
      !compiled.normalizedPlan ||
      !compiled.generationGraph
    ) {
      return failedResult(
        context,
        schemaMetadata,
        task,
        compiled,
        'compile',
        compiled.diagnostics,
      );
    }

    let beforeExecution: ValidatedRepositoryTaskIdentity;
    try {
      beforeExecution = await identityValidator.validate({
        repositoryRoot: dependencies.repositoryRoot,
        identity: task.repositoryIdentity,
        repositorySnapshot: task.repositorySnapshot,
        repositoryProfile: task.repositoryProfile,
        normalizedPlan: compiled.normalizedPlan,
        phase: 'before-execution',
      });
    } catch (error) {
      return failedResult(
        context,
        schemaMetadata,
        task,
        compiled,
        'verify',
        [repositoryIdentityDiagnostic(error)],
      );
    }

    const execution = await executor.execute({
      repositoryRoot: dependencies.repositoryRoot,
      normalizedPlan: compiled.normalizedPlan,
      repositoryProfile: task.repositoryProfile,
      generationGraph: compiled.generationGraph,
      verificationProfiles: dependencies.verificationProfiles,
    });

    let afterExecution: ValidatedRepositoryTaskIdentity;
    try {
      afterExecution = await identityValidator.validate({
        repositoryRoot: dependencies.repositoryRoot,
        identity: task.repositoryIdentity,
        repositorySnapshot: task.repositorySnapshot,
        repositoryProfile: task.repositoryProfile,
        normalizedPlan: compiled.normalizedPlan,
        phase: 'after-execution',
      });
    } catch (error) {
      return failedResult(
        context,
        schemaMetadata,
        task,
        compiled,
        'verify',
        [repositoryIdentityDiagnostic(error)],
        { beforeExecution },
      );
    }

    const repositoryIdentity = { beforeExecution, afterExecution };
    const evidence = {
      ...execution.evidence,
      repositoryIdentity,
    };
    const disposition = {
      status: execution.status,
      phase: execution.status === 'succeeded' ? 'complete' : 'verify',
      evidenceId: execution.evidence.evidenceId,
      patchDigest: execution.evidence.patchDigest,
      repositoryIdentity,
      diagnostics: execution.evidence.diagnostics,
    };
    const artifacts = await stageArtifacts(context, schemaMetadata, {
      authoredPlan: compiled.authoredPlan,
      normalizedPlan: compiled.normalizedPlan,
      generationGraph: compiled.generationGraph,
      patch: {
        patch: execution.patch,
        patchDigest: execution.evidence.patchDigest,
      },
      evidence,
      diagnostics: execution.evidence.diagnostics,
      disposition,
    });
    return completed(context, artifacts);
  };
}

export function createRepositoryTaskRegistry(
  dependencies: RepositoryTaskWorkerDependencies,
): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register(
    'repository-task',
    '1',
    createRepositoryTaskComponent(dependencies),
  );
  return registry;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('FACTORY_FLOOR_WORKER_CONCURRENCY must be positive');
  }
  return parsed;
}

export function factoryFloorVerificationProfiles(): RepositoryTaskVerificationProfiles {
  return {
    'factory-floor': {
      stages: [
        {
          id: 'bootstrap',
          executable: 'bash',
          args: ['scripts/bootstrap-workspace.sh'],
          timeoutMs: 300_000,
        },
        {
          id: 'static',
          executable: 'pnpm',
          args: ['verify:static'],
          timeoutMs: 180_000,
        },
        {
          id: 'unit',
          executable: 'pnpm',
          args: ['verify:unit'],
          timeoutMs: 180_000,
        },
      ],
    },
  };
}

export async function startRepositoryTaskWorkerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const client = new WorkerProtocolClient({
    baseUrl: required(env, 'FACTORY_FLOOR_WORKER_BASE_URL'),
    bearerToken: required(env, 'FACTORY_FLOOR_WORKER_TOKEN'),
    workerId: required(env, 'FACTORY_FLOOR_WORKER_ID'),
  });
  const runner = new WorkerRunner({
    client,
    registry: createRepositoryTaskRegistry({
      repositoryRoot: required(env, 'FACTORY_FLOOR_REPOSITORY_ROOT'),
      verificationProfiles: factoryFloorVerificationProfiles(),
      schemaMetadata: repositoryTaskSchemaMetadataFromEnv(env),
    }),
    concurrency: positiveInteger(env.FACTORY_FLOOR_WORKER_CONCURRENCY, 1),
    logger: (event, fields) =>
      console.log(JSON.stringify({ event, ...fields })),
  });
  runner.installSignalHandlers();
  await runner.run();
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void startRepositoryTaskWorkerFromEnv().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
