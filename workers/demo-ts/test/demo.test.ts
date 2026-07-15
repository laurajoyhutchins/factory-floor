import { describe, expect, it } from 'vitest';
import { createDemoRegistry } from '../src/index.js';
import type {
  InvocationEnvelope,
  ProposedResult,
  StagedArtifact,
} from '@factory-floor/contracts-ts';
import fixture from '../../../contracts/fixtures/worker/invocation-envelope.valid.json' with {
  type: 'json',
};

async function run(name: string, payload: unknown) {
  const registry = createDemoRegistry();
  const envelope = {
    ...(fixture as InvocationEnvelope),
    inputs: [
      {
        portName: 'in',
        deliveryId: '018f6f73-8d5b-7cc8-9ed9-6b2f4e25d020',
        payload,
        artifacts: [],
        artifactReadUrls: [],
      },
    ],
    component: {
      ...(fixture as InvocationEnvelope).component,
      definitionName: name,
      definitionVersion: '1',
    },
  };
  const staged: { portName: string; value: unknown }[] = [];
  const component = registry.get(name, '1');
  if (!component) throw new Error('missing');
  const result = (await component({
    envelope,
    signal: new AbortController().signal,
    client: {} as never,
    log: () => undefined,
    invokeCapability: async () => ({
      protocolVersion: '1.0',
      output: {},
      auditId: 'a',
    }),
    stageBinary: async () => {
      throw new Error('unused');
    },
    stageJson: async (portName, value) => {
      staged.push({ portName, value });
      return {
        stagingId: '018f6f73-8d5b-7cc8-9ed9-6b2f4e25d021',
        portName,
        digest: 'a'.repeat(64),
        sizeBytes: 1,
        mediaType: 'application/json',
        schemaId: 's',
        schemaDigest: 'b'.repeat(64),
        provenance: {
          kind: 'execution',
          executionId: envelope.executionId,
          attemptId: envelope.attemptId,
        },
      } satisfies StagedArtifact;
    },
  })) as ProposedResult;
  return { result, staged, stable: JSON.stringify(staged) };
}

describe('deterministic demo components', () => {
  it('registers retrieve compare and synthesize', () => {
    expect(createDemoRegistry().capabilities()).toEqual([
      'compare@1',
      'retrieve@1',
      'synthesize@1',
    ]);
  });

  it('retrieve is deterministic and provenance-shaped', async () => {
    const a = await run('retrieve', { query: 'alpha' });
    const b = await run('retrieve', { query: 'alpha' });
    expect(a.stable).toBe(b.stable);
    expect(a.stable).toContain('repo-fixture:demo-ts/retrieve');
    expect(a.staged.map((item) => item.portName)).toEqual(['evidence']);
  });

  it('compare emits the canonical candidate-claims port', async () => {
    const a = await run('compare', { z: 1, a: 2 });
    const b = await run('compare', { a: 2, z: 1 });
    expect(a.stable).toBe(b.stable);
    expect(a.staged.map((item) => item.portName)).toEqual([
      'candidate-claims',
    ]);
  });

  it('synthesize emits every required canonical output port', async () => {
    const a = await run('synthesize', { finding: 'x' });
    const b = await run('synthesize', { finding: 'x' });
    expect(a.stable).toBe(b.stable);
    expect(a.stable).toContain('Deterministic synthesis complete');
    expect(a.staged.map((item) => item.portName)).toEqual([
      'result',
      'evidence-bundle',
      'uncertainty-report',
    ]);
    expect(a.result.stagedArtifacts).toHaveLength(3);
  });
});
