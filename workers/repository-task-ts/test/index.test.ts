import { describe, expect, it, vi } from 'vitest';
import type { WorkerExecutionContext } from '@factory-floor/worker-sdk-ts';
import {
  createRepositoryTaskComponent,
  createRepositoryTaskRegistry,
  repositoryTaskSchemaMetadataFromEnv,
  type RepositoryTaskArtifactSchemaMetadata,
  type RepositoryTaskCompiler,
  type RepositoryTaskExecutor,
  type RepositoryTaskIdentityValidator,
  type RepositoryTaskRepositoryIdentity,
  type RepositoryTaskSchemaMetadata,
} from '../src/index.js';

function context(payload: unknown) {
  const staged: Array<{
    portName: string;
    value: unknown;
    metadata: RepositoryTaskArtifactSchemaMetadata;
  }> = [];
  const value = {
    envelope: {
      protocolVersion: '1.0',
      executionId: 'execution-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      leaseToken: 'lease-1',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      lifecycleEpoch: 1,
      component: {
        componentId: 'component-1',
        definitionId: 'definition-1',
        definitionName: 'repository-task',
        definitionVersion: '1',
        definition: {},
        configuration: {},
      },
      inputs: [
        {
          portName: 'task',
          deliveryId: 'delivery-1',
          payload,
          artifacts: [],
          artifactReadUrls: [],
        },
      ],
      state: null,
      capabilityHandles: [],
      cancellationUrl: '/cancel',
      heartbeatUrl: '/heartbeat',
      resultSubmissionUrl: '/result',
      artifactStagingUrl: '/artifacts',
      capabilityInvocationUrl: '/capabilities',
      traceContext: {},
      limits: { heartbeatIntervalMs: 30_000, maxArtifactBytes: 1_000_000 },
      source: { kind: 'command', commandId: 'command-1', submittedBy: 'test' },
    },
    client: {},
    signal: new AbortController().signal,
    log: vi.fn(),
    stageJson: vi.fn(
      async (
        portName: string,
        artifact: unknown,
        metadata: RepositoryTaskArtifactSchemaMetadata,
      ) => {
        staged.push({ portName, value: artifact, metadata });
        return {
          stagingId: `staging-${portName}`,
          portName,
          digest: 'a'.repeat(64),
          sizeBytes: 1,
          mediaType: 'application/json',
          schemaId: metadata.schemaId,
          schemaDigest: metadata.schemaDigest,
          provenance: {
            kind: 'execution',
            executionId: 'execution-1',
            attemptId: 'attempt-1',
          },
        };
      },
    ),
    stageBinary: vi.fn(),
    invokeCapability: vi.fn(),
  } as unknown as WorkerExecutionContext;
  return { value, staged };
}

const normalizedPlan = {
  planDigest: 'c'.repeat(64),
  repository: {
    owner: 'laurajoyhutchins',
    name: 'factory-floor',
    baseRevision: 'd'.repeat(40),
  },
  allowedPaths: ['packages/runtime-core/src/example.ts'],
  recipe: { name: 'typescript-module', version: '1' },
  outputs: [],
  verificationProfile: 'factory-floor',
  resourceBounds: {
    maxFiles: 3,
    maxPatchBytes: 100_000,
    maxVerificationSeconds: 600,
  },
};
const repositoryProfile = {
  repository: { owner: 'laurajoyhutchins', name: 'factory-floor' },
  pathBoundaries: ['packages/runtime-core/**'],
  recipes: { 'typescript-module': ['1'] },
  verificationProfiles: ['factory-floor'],
};
const repositorySnapshot = { files: {} };
const repositoryIdentity: RepositoryTaskRepositoryIdentity = {
  repository: { owner: 'laurajoyhutchins', name: 'factory-floor' },
  baseRevision: normalizedPlan.repository.baseRevision,
  snapshotDigest: '0'.repeat(64),
  dirtyStatePolicy: 'require-clean',
};
const generationGraph = {
  graphDigest: 'e'.repeat(64),
  profileDigest: 'f'.repeat(64),
  planDigest: normalizedPlan.planDigest,
  repository: normalizedPlan.repository,
  recipe: normalizedPlan.recipe,
  verificationProfile: 'factory-floor',
  nodes: [],
  outputs: [],
  conflicts: [],
};
const schemaMetadata: RepositoryTaskSchemaMetadata = {
  'repository-task-authored-plan.v1': {
    schemaId: 'schema-authored-plan',
    schemaDigest: '1'.repeat(64),
  },
  'repository-task-normalized-plan.v1': {
    schemaId: 'schema-normalized-plan',
    schemaDigest: '2'.repeat(64),
  },
  'repository-task-generation-graph.v1': {
    schemaId: 'schema-generation-graph',
    schemaDigest: '3'.repeat(64),
  },
  'repository-task-patch.v1': {
    schemaId: 'schema-patch',
    schemaDigest: '4'.repeat(64),
  },
  'repository-task-evidence.v1': {
    schemaId: 'schema-evidence',
    schemaDigest: '5'.repeat(64),
  },
  'repository-task-diagnostics.v1': {
    schemaId: 'schema-diagnostics',
    schemaDigest: '6'.repeat(64),
  },
  'repository-task-disposition.v1': {
    schemaId: 'schema-disposition',
    schemaDigest: '7'.repeat(64),
  },
};

function input() {
  return {
    authoredPlanMarkdown: '---\nschemaVersion: 1\n---\nAdd a descriptor.',
    repositoryProfile,
    repositorySnapshot,
    repositoryIdentity,
  };
}

function successfulCompiler(): RepositoryTaskCompiler {
  return {
    compile: vi.fn(async () => ({
      authoredPlan: { objective: 'Add a bounded component descriptor.' },
      normalizedPlan,
      generationGraph,
      diagnostics: [],
    })),
  };
}

function successfulExecutor(): RepositoryTaskExecutor {
  return {
    execute: vi.fn(async () => ({
      status: 'succeeded',
      patch: 'diff --git a/example b/example\n',
      evidence: {
        evidenceId: '1'.repeat(64),
        status: 'succeeded',
        diagnostics: [],
        mutations: [],
        verification: [],
      },
    })),
  };
}

function successfulIdentityValidator(): RepositoryTaskIdentityValidator {
  return {
    validate: vi.fn(async ({ identity, phase }) => ({
      ...identity,
      phase,
      observedHeadRevision: identity.baseRevision,
      observedDirtyState: 'clean' as const,
    })),
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    repositoryRoot: '/trusted/repository',
    verificationProfiles: { factoryFloor: { stages: [] } },
    schemaMetadata,
    identityValidator: successfulIdentityValidator(),
    compiler: successfulCompiler(),
    executor: successfulExecutor(),
    ...overrides,
  };
}

describe('repository-task worker', () => {
  it('retains artifacts with authoritative schema metadata and validated repository identity', async () => {
    const compiler = successfulCompiler();
    const executor = successfulExecutor();
    const identityValidator = successfulIdentityValidator();
    const component = createRepositoryTaskComponent(
      dependencies({ compiler, executor, identityValidator }),
    );
    const workerContext = context(input());

    const result = await component(workerContext.value);

    expect(result).toMatchObject({
      status: 'completed',
      stagedArtifacts: expect.any(Array),
      externalActionProposals: [],
    });
    expect(workerContext.staged.map(({ portName }) => portName)).toEqual([
      'authored-plan',
      'normalized-plan',
      'generation-graph',
      'patch',
      'evidence',
      'diagnostics',
      'disposition',
    ]);
    expect(workerContext.staged[0]?.metadata).toEqual(
      schemaMetadata['repository-task-authored-plan.v1'],
    );
    expect(workerContext.staged.at(-1)?.value).toMatchObject({
      status: 'succeeded',
      evidenceId: '1'.repeat(64),
      repositoryIdentity: {
        beforeExecution: { observedDirtyState: 'clean' },
        afterExecution: { observedDirtyState: 'clean' },
      },
    });
    expect(compiler.compile).toHaveBeenCalledWith(input());
    expect(identityValidator.validate).toHaveBeenCalledTimes(2);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryRoot: '/trusted/repository',
        normalizedPlan,
        repositoryProfile,
        generationGraph,
      }),
    );
  });

  it('retains deterministic compiler diagnostics without validating or invoking the executor', async () => {
    const executor = successfulExecutor();
    const identityValidator = successfulIdentityValidator();
    const component = createRepositoryTaskComponent(
      dependencies({
        compiler: {
          compile: vi.fn(async () => ({
            authoredPlan: null,
            normalizedPlan: null,
            generationGraph: null,
            diagnostics: [
              {
                code: 'markdown.invalid',
                severity: 'error',
                path: '',
                message: 'Invalid plan.',
              },
            ],
          })),
        },
        executor,
        identityValidator,
      }),
    );
    const workerContext = context(input());

    const result = await component(workerContext.value);

    expect(result).toMatchObject({ status: 'completed' });
    expect(identityValidator.validate).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(workerContext.staged.at(-1)?.value).toMatchObject({
      status: 'failed',
      diagnostics: [{ code: 'markdown.invalid' }],
    });
  });

  it('fails closed when repository identity changes after execution', async () => {
    const beforeExecution = {
      ...repositoryIdentity,
      phase: 'before-execution' as const,
      observedHeadRevision: repositoryIdentity.baseRevision,
      observedDirtyState: 'clean' as const,
    };
    const identityValidator: RepositoryTaskIdentityValidator = {
      validate: vi
        .fn()
        .mockResolvedValueOnce(beforeExecution)
        .mockRejectedValueOnce(
          new Error('repository changed after compilation'),
        ),
    };
    const component = createRepositoryTaskComponent(
      dependencies({ identityValidator }),
    );
    const workerContext = context(input());

    const result = await component(workerContext.value);

    expect(result).toMatchObject({ status: 'completed' });
    expect(
      workerContext.staged.find(({ portName }) => portName === 'patch'),
    ).toMatchObject({ value: { patch: '', patchDigest: null } });
    expect(workerContext.staged.at(-1)?.value).toMatchObject({
      status: 'failed',
      phase: 'verify',
      repositoryIdentity: { beforeExecution },
      diagnostics: [{ code: 'worker.repository-identity-mismatch' }],
    });
  });

  it('requires complete authoritative schema registration metadata', () => {
    expect(() => repositoryTaskSchemaMetadataFromEnv({})).toThrow(
      'FACTORY_FLOOR_SCHEMA_DIGESTS is required',
    );
    expect(() =>
      repositoryTaskSchemaMetadataFromEnv({
        FACTORY_FLOOR_SCHEMA_DIGESTS: JSON.stringify({
          'repository-task-authored-plan.v1': {
            id: 'schema-authored-plan',
            digest: '1'.repeat(64),
          },
        }),
      }),
    ).toThrow('repository-task-normalized-plan.v1');
  });

  it('registers the supported durable component selector', () => {
    const registry = createRepositoryTaskRegistry(dependencies());

    expect(registry.supportedComponentSelectors()).toEqual([
      'repository-task@1',
    ]);
  });
});
