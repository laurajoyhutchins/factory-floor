import { describe, expect, it, vi } from 'vitest';
import type { WorkerExecutionContext } from '@factory-floor/worker-sdk-ts';
import {
  createRepositoryTaskComponent,
  createRepositoryTaskRegistry,
  type RepositoryTaskCompiler,
  type RepositoryTaskExecutor,
} from '../src/index.js';

function context(payload: unknown) {
  const staged: Array<{ portName: string; value: unknown }> = [];
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
    stageJson: vi.fn(async (portName: string, artifact: unknown) => {
      staged.push({ portName, value: artifact });
      return {
        stagingId: `staging-${portName}`,
        portName,
        digest: 'a'.repeat(64),
        sizeBytes: 1,
        mediaType: 'application/json',
        schemaId: `${portName}.v1`,
        schemaDigest: 'b'.repeat(64),
        provenance: {
          kind: 'execution',
          executionId: 'execution-1',
          attemptId: 'attempt-1',
        },
      };
    }),
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

describe('repository-task worker', () => {
  it('retains authored, normalized, graph, patch, evidence, diagnostics, and disposition artifacts', async () => {
    const compiler = successfulCompiler();
    const executor = successfulExecutor();
    const component = createRepositoryTaskComponent({
      repositoryRoot: '/trusted/repository',
      verificationProfiles: { factoryFloor: { stages: [] } },
      compiler,
      executor,
    });
    const input = {
      authoredPlanMarkdown: '---\nschemaVersion: 1\n---\nAdd a descriptor.',
      repositoryProfile,
      repositorySnapshot: { files: {} },
    };
    const workerContext = context(input);

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
    expect(workerContext.staged.at(-1)?.value).toMatchObject({
      status: 'succeeded',
      evidenceId: '1'.repeat(64),
    });
    expect(compiler.compile).toHaveBeenCalledWith(input);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryRoot: '/trusted/repository',
        normalizedPlan,
        repositoryProfile,
        generationGraph,
      }),
    );
  });

  it('retains deterministic compiler diagnostics without invoking the executor', async () => {
    const executor = successfulExecutor();
    const component = createRepositoryTaskComponent({
      repositoryRoot: '/trusted/repository',
      verificationProfiles: {},
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
    });
    const workerContext = context({
      authoredPlanMarkdown: 'invalid',
      repositoryProfile,
      repositorySnapshot: { files: {} },
    });

    const result = await component(workerContext.value);

    expect(result).toMatchObject({ status: 'completed' });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(workerContext.staged.map(({ portName }) => portName)).toEqual([
      'authored-plan',
      'normalized-plan',
      'generation-graph',
      'patch',
      'evidence',
      'diagnostics',
      'disposition',
    ]);
    expect(workerContext.staged.at(-1)?.value).toMatchObject({
      status: 'failed',
      diagnostics: [{ code: 'markdown.invalid' }],
    });
  });

  it('registers the supported durable component selector', () => {
    const registry = createRepositoryTaskRegistry({
      repositoryRoot: '/trusted/repository',
      verificationProfiles: {},
      compiler: successfulCompiler(),
      executor: successfulExecutor(),
    });

    expect(registry.supportedComponentSelectors()).toEqual([
      'repository-task@1',
    ]);
  });
});
