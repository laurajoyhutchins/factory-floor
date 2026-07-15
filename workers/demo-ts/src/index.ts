import {
  ComponentRegistry,
  WorkerProtocolClient,
  WorkerRunner,
  canonicalJson,
  emptyResourceUsage,
  type WorkerComponent,
} from '@factory-floor/worker-sdk-ts';
import type {
  ProposedResult,
  StagedArtifact,
} from '@factory-floor/contracts-ts';

const schemaDigestPlaceholder = '0'.repeat(64);

function schemaMetadata(schemaId: string) {
  return { schemaId, schemaDigest: schemaDigestPlaceholder };
}

function completed(
  context: {
    envelope: {
      executionId: string;
      attemptId: string;
      leaseToken: string;
      lifecycleEpoch: number;
    };
  },
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

function firstPayload(
  inputs: { payload: unknown }[],
): Record<string, unknown> {
  return (inputs[0]?.payload && typeof inputs[0].payload === 'object'
    ? inputs[0].payload
    : {}) as Record<string, unknown>;
}

function stableString(value: unknown): string {
  return new TextDecoder().decode(canonicalJson(value));
}

export const retrieveComponent: WorkerComponent = async (context) => {
  const input = firstPayload(context.envelope.inputs);
  const query = String(input.query ?? input.objective ?? 'investigation');
  const evidence = [
    {
      source: 'repo-fixture:demo-ts/retrieve',
      query,
      title: `Evidence for ${query}`,
      claim: `Deterministic evidence about ${query}`,
      rank: 1,
    },
  ];
  const artifact = await context.stageJson(
    'evidence',
    { evidence },
    schemaMetadata('evidence.v1'),
  );
  return completed(context, [artifact]);
};

export const compareComponent: WorkerComponent = async (context) => {
  const payloads = context.envelope.inputs
    .map((input) => input.payload)
    .sort((left, right) =>
      stableString(left).localeCompare(stableString(right)),
    );
  const comparisons = payloads.map((payload, index) => ({
    candidate: `candidate-${index + 1}`,
    basis: JSON.parse(stableString(payload)) as unknown,
    score: index + 1,
  }));
  const artifact = await context.stageJson(
    'candidate-claims',
    { comparisons },
    schemaMetadata('candidate-claims.v1'),
  );
  return completed(context, [artifact]);
};

export const synthesizeComponent: WorkerComponent = async (context) => {
  const findings = context.envelope.inputs
    .map((input) => input.payload)
    .sort((left, right) =>
      stableString(left).localeCompare(stableString(right)),
    );
  const normalizedFindings = findings.map(
    (finding) => JSON.parse(stableString(finding)) as unknown,
  );
  const result = {
    summary: 'Deterministic synthesis complete.',
    findings: normalizedFindings,
    generatedBy: 'demo-ts@synthesize@1',
  };
  const evidenceBundle = {
    evidence: normalizedFindings,
    generatedBy: 'demo-ts@synthesize@1',
  };
  const uncertaintyReport = {
    uncertainties: [],
    complete: true,
    generatedBy: 'demo-ts@synthesize@1',
  };

  const artifacts = await Promise.all([
    context.stageJson('result', result, schemaMetadata('result.v1')),
    context.stageJson(
      'evidence-bundle',
      evidenceBundle,
      schemaMetadata('evidence-bundle.v1'),
    ),
    context.stageJson(
      'uncertainty-report',
      uncertaintyReport,
      schemaMetadata('uncertainty-report.v1'),
    ),
  ]);
  return completed(context, artifacts);
};

export function createDemoRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register('retrieve', '1', retrieveComponent);
  registry.register('compare', '1', compareComponent);
  registry.register('synthesize', '1', synthesizeComponent);
  return registry;
}

export async function startDemoWorkerFromEnv(): Promise<void> {
  const baseUrl =
    process.env.FACTORY_FLOOR_WORKER_BASE_URL ?? 'http://localhost:3000';
  const bearerToken = process.env.FACTORY_FLOOR_WORKER_TOKEN ?? '';
  if (bearerToken.length === 0)
    throw new Error('FACTORY_FLOOR_WORKER_TOKEN is required');
  const workerId =
    process.env.FACTORY_FLOOR_WORKER_ID ?? 'demo-ts-worker';
  const concurrency = Number(
    process.env.FACTORY_FLOOR_WORKER_CONCURRENCY ?? '1',
  );
  const client = new WorkerProtocolClient({
    baseUrl,
    bearerToken,
    workerId,
  });
  const runner = new WorkerRunner({
    client,
    registry: createDemoRegistry(),
    concurrency,
    logger: (event, fields) =>
      console.log(JSON.stringify({ event, ...fields })),
  });
  runner.installSignalHandlers();
  await runner.run();
}

if (process.argv[1]?.endsWith('/index.js')) void startDemoWorkerFromEnv();
