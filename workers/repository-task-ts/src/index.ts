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

function schemaMetadata(schemaKey: string) {
  const schemas = JSON.parse(
    process.env.FACTORY_FLOOR_SCHEMA_DIGESTS ?? '{}',
  ) as Record<string, { id: string; digest: string }>;
  const schema = schemas[schemaKey];
  return {
    schemaId: schema?.id ?? schemaKey,
    schemaDigest:
      schema?.digest ?? createHash('sha256').update(schemaKey).digest('hex'),
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
    )
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
      await context.stageJson(portName, value, schemaMetadata(schemaKey)),
    );
  }
  return artifacts;
}

export function createRepositoryTaskComponent(
  dependencies: RepositoryTaskWorkerDependencies,
): WorkerComponent {
  const compiler = dependencies.compiler ?? createRepositoryTaskCompiler();
  const executor = dependencies.executor ?? createRepositoryTaskExecutor();
  return async (context) => {
    const task = payload(context);
    const compiled = task
      ? await compiler.compile(task)
      : invalidInput(
          'The task input must include authoredPlanMarkdown, repositoryProfile, and a string-valued repositorySnapshot.files map.',
        );
    if (
      !task ||
      compiled.diagnostics.length > 0 ||
      !compiled.authoredPlan ||
      !compiled.normalizedPlan ||
      !compiled.generationGraph
    ) {
      const disposition = {
        status: 'failed',
        phase: 'compile',
        diagnostics: compiled.diagnostics,
      };
      const artifacts = await stageArtifacts(context, {
        authoredPlan: compiled.authoredPlan ?? {
          markdown: task?.authoredPlanMarkdown ?? null,
        },
        normalizedPlan: compiled.normalizedPlan,
        generationGraph: compiled.generationGraph,
        patch: { patch: '', patchDigest: null },
        evidence: null,
        diagnostics: compiled.diagnostics,
        disposition,
      });
      return completed(context, artifacts);
    }

    const execution = await executor.execute({
      repositoryRoot: dependencies.repositoryRoot,
      normalizedPlan: compiled.normalizedPlan,
      repositoryProfile: task.repositoryProfile,
      generationGraph: compiled.generationGraph,
      verificationProfiles: dependencies.verificationProfiles,
    });
    const disposition = {
      status: execution.status,
      phase: execution.status === 'succeeded' ? 'complete' : 'verify',
      evidenceId: execution.evidence.evidenceId,
      patchDigest: execution.evidence.patchDigest,
      diagnostics: execution.evidence.diagnostics,
    };
    const artifacts = await stageArtifacts(context, {
      authoredPlan: compiled.authoredPlan,
      normalizedPlan: compiled.normalizedPlan,
      generationGraph: compiled.generationGraph,
      patch: {
        patch: execution.patch,
        patchDigest: execution.evidence.patchDigest,
      },
      evidence: execution.evidence,
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

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
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
          id: 'install',
          executable: 'pnpm',
          args: ['install', '--frozen-lockfile'],
          timeoutMs: 180_000,
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
