import { ComponentRegistry, WorkerProtocolClient, WorkerRunner, canonicalJson, emptyResourceUsage, type WorkerComponent } from '@factory-floor/worker-sdk-ts';
import type { ProposedResult, StagedArtifact } from '@factory-floor/contracts-ts';

function completed(ctx: { envelope: { executionId: string; attemptId: string; leaseToken: string; lifecycleEpoch: number } }, artifacts: StagedArtifact[]): ProposedResult {
  return { protocolVersion: '1.0', executionId: ctx.envelope.executionId, attemptId: ctx.envelope.attemptId, leaseToken: ctx.envelope.leaseToken, lifecycleEpoch: ctx.envelope.lifecycleEpoch, status: 'completed', stagedArtifacts: artifacts, proposedEvents: [], externalActionProposals: [], resourceUsage: emptyResourceUsage() };
}

function firstPayload(inputs: { payload: unknown }[]): Record<string, unknown> { return (inputs[0]?.payload && typeof inputs[0].payload === 'object' ? inputs[0].payload : {}) as Record<string, unknown>; }
function stableString(value: unknown): string { return new TextDecoder().decode(canonicalJson(value)); }

export const retrieveComponent: WorkerComponent = async (ctx) => {
  const input = firstPayload(ctx.envelope.inputs);
  const query = String(input.query ?? input.objective ?? 'investigation');
  const evidence = [{ source: 'repo-fixture:demo-ts/retrieve', query, title: `Evidence for ${query}`, claim: `Deterministic evidence about ${query}`, rank: 1 }];
  const artifact = await ctx.stageJson('evidence', { evidence }, { schemaId: 'investigation.evidence', schemaDigest: '0'.repeat(64) });
  return completed(ctx, [artifact]);
};

export const compareComponent: WorkerComponent = async (ctx) => {
  const payloads = ctx.envelope.inputs.map((input) => input.payload).sort((a, b) => stableString(a).localeCompare(stableString(b)));
  const comparisons = payloads.map((payload, index) => ({ candidate: `candidate-${index + 1}`, basis: JSON.parse(stableString(payload)) as unknown, score: index + 1 }));
  const artifact = await ctx.stageJson('candidateClaims', { comparisons }, { schemaId: 'investigation.candidateClaims', schemaDigest: '0'.repeat(64) });
  return completed(ctx, [artifact]);
};

export const synthesizeComponent: WorkerComponent = async (ctx) => {
  const findings = ctx.envelope.inputs.map((input) => input.payload).sort((a, b) => stableString(a).localeCompare(stableString(b)));
  const final = { summary: 'Deterministic synthesis complete.', findings: findings.map((finding) => JSON.parse(stableString(finding)) as unknown), generatedBy: 'demo-ts@synthesize@1' };
  const artifact = await ctx.stageJson('finalReport', final, { schemaId: 'investigation.finalReport', schemaDigest: '0'.repeat(64) });
  return completed(ctx, [artifact]);
};

export function createDemoRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register('retrieve', '1', retrieveComponent);
  registry.register('compare', '1', compareComponent);
  registry.register('synthesize', '1', synthesizeComponent);
  return registry;
}

export async function startDemoWorkerFromEnv(): Promise<void> {
  const baseUrl = process.env.FACTORY_FLOOR_WORKER_BASE_URL ?? 'http://localhost:3000';
  const bearerToken = process.env.FACTORY_FLOOR_WORKER_TOKEN ?? '';
  const workerId = process.env.FACTORY_FLOOR_WORKER_ID ?? 'demo-ts-worker';
  const concurrency = Number(process.env.FACTORY_FLOOR_WORKER_CONCURRENCY ?? '1');
  const client = new WorkerProtocolClient({ baseUrl, bearerToken, workerId });
  const runner = new WorkerRunner({ client, registry: createDemoRegistry(), concurrency, logger: (event, fields) => console.log(JSON.stringify({ event, ...fields })) });
  runner.installSignalHandlers();
  await runner.run();
}

if (process.argv[1]?.endsWith('/index.js')) void startDemoWorkerFromEnv();
