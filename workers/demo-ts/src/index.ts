import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
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

function firstPayload(inputs: { payload: unknown }[]): Record<string, unknown> {
  return (
    inputs[0]?.payload && typeof inputs[0].payload === 'object'
      ? inputs[0].payload
      : {}
  ) as Record<string, unknown>;
}

function stableString(value: unknown): string {
  return new TextDecoder().decode(canonicalJson(value));
}

export const retrieveComponent: WorkerComponent = async (context) => {
  const input = firstPayload(context.envelope.inputs);
  const query = String(input.query ?? input.objective ?? 'investigation');
  const configuration = context.envelope.component.configuration;
  const sourceClass =
    configuration && typeof configuration === 'object'
      ? String(
          (configuration as Record<string, unknown>).sourceClass ?? 'fixture',
        )
      : 'fixture';
  const evidence = [
    {
      source: `repo-fixture:demo-ts/retrieve:${sourceClass}`,
      query,
      title: `${sourceClass} evidence for ${query}`,
      claim: `Deterministic ${sourceClass} evidence about ${query}`,
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

export interface DemoWorkerConfig {
  baseUrl: string;
  bearerToken: string;
  workerId: string;
  concurrency: number;
}

export interface DemoWorkerSignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface DemoWorkerProcessOptions {
  env?: Record<string, string | undefined>;
  signalSource?: DemoWorkerSignalSource;
  createClient?: (config: DemoWorkerConfig) => WorkerProtocolClient;
  createRunner?: (options: {
    client: WorkerProtocolClient;
    registry: ComponentRegistry;
    concurrency: number;
  }) => WorkerRunner;
}

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function workerBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      'FACTORY_FLOOR_WORKER_BASE_URL must be a valid http or https URL',
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error(
      'FACTORY_FLOOR_WORKER_BASE_URL must be a valid http or https URL',
    );
  if (parsed.username || parsed.password)
    throw new Error(
      'FACTORY_FLOOR_WORKER_BASE_URL must not contain credentials',
    );
  return parsed.href.endsWith('/') ? parsed.href.slice(0, -1) : parsed.href;
}

export function loadDemoWorkerConfig(
  env: Record<string, string | undefined>,
): DemoWorkerConfig {
  const concurrency = Number(
    env.FACTORY_FLOOR_WORKER_CONCURRENCY?.trim() ?? '1',
  );
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error(
      'FACTORY_FLOOR_WORKER_CONCURRENCY must be a positive integer',
    );
  return {
    baseUrl: workerBaseUrl(required(env, 'FACTORY_FLOOR_WORKER_BASE_URL')),
    bearerToken: required(env, 'FACTORY_FLOOR_WORKER_TOKEN'),
    workerId: required(env, 'FACTORY_FLOOR_WORKER_ID'),
    concurrency,
  };
}

export function createShutdownFencedClient(
  client: WorkerProtocolClient,
  isStopping: () => boolean,
): WorkerProtocolClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'claim')
        return async (
          ...args: Parameters<WorkerProtocolClient['claim']>
        ): ReturnType<WorkerProtocolClient['claim']> => {
          if (isStopping())
            return {
              protocolVersion: '1.0',
              claimed: false,
              retryAfterMs: 0,
            };
          return target.claim(...args);
        };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export async function startDemoWorkerFromEnv(
  options: DemoWorkerProcessOptions = {},
): Promise<void> {
  const config = loadDemoWorkerConfig(options.env ?? process.env);
  const signalSource = options.signalSource ?? process;
  let stopping = false;
  const rawClient = (
    options.createClient ??
    ((workerConfig) =>
      new WorkerProtocolClient({
        baseUrl: workerConfig.baseUrl,
        bearerToken: workerConfig.bearerToken,
        workerId: workerConfig.workerId,
      }))
  )(config);
  const client = createShutdownFencedClient(rawClient, () => stopping);
  const runner = (
    options.createRunner ??
    ((runnerOptions) =>
      new WorkerRunner({
        ...runnerOptions,
        logger: (event, fields) =>
          console.log(JSON.stringify({ event, ...fields })),
      }))
  )({
    client,
    registry: createDemoRegistry(),
    concurrency: config.concurrency,
  });
  const stop = () => {
    stopping = true;
    runner.stop();
  };

  signalSource.once('SIGINT', stop);
  signalSource.once('SIGTERM', stop);
  try {
    await runner.run();
  } finally {
    stopping = true;
    signalSource.off('SIGINT', stop);
    signalSource.off('SIGTERM', stop);
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href)
  void startDemoWorkerFromEnv().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
