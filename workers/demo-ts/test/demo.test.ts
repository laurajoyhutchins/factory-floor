import { describe, expect, it } from 'vitest';
import { createDemoRegistry } from '../src/index.js';
import type { InvocationEnvelope, StagedArtifact } from '@factory-floor/contracts-ts';
import fixture from '../../../contracts/fixtures/worker/invocation-envelope.valid.json' with { type: 'json' };

async function run(name: string, payload: unknown) {
  const registry = createDemoRegistry();
  const envelope = { ...(fixture as InvocationEnvelope), inputs: [{ portName: 'in', deliveryId: 'd', payload, artifacts: [], artifactReadUrls: [] }], component: { ...(fixture as InvocationEnvelope).component, definitionName: name, definitionVersion: '1' } };
  const staged: unknown[] = [];
  const component = registry.get(name, '1');
  if (!component) throw new Error('missing');
  const result = await component({ envelope, signal: new AbortController().signal, client: {} as never, log: () => undefined, invokeCapability: async () => ({ protocolVersion: '1.0', output: {}, auditId: 'a' }), stageBinary: async () => { throw new Error('unused'); }, stageJson: async (portName, value) => { staged.push(value); return { stagingId: `${portName}-1`, portName, digest: 'a'.repeat(64), sizeBytes: 1, mediaType: 'application/json', schemaId: 's', schemaDigest: 'b'.repeat(64), provenance: { kind: 'execution', executionId: 'e', attemptId: 'a' } } satisfies StagedArtifact; } });
  return { result, staged: JSON.stringify(staged) };
}

describe('deterministic demo components', () => {
  it('registers retrieve compare and synthesize', () => { expect(createDemoRegistry().capabilities()).toEqual(['compare@1','retrieve@1','synthesize@1']); });
  it('retrieve is deterministic and provenance-shaped', async () => { const a = await run('retrieve', { query: 'alpha' }); const b = await run('retrieve', { query: 'alpha' }); expect(a.staged).toBe(b.staged); expect(a.staged).toContain('repo-fixture:demo-ts/retrieve'); });
  it('compare uses stable ordering and byte-identical output', async () => { const a = await run('compare', { z: 1, a: 2 }); const b = await run('compare', { a: 2, z: 1 }); expect(a.staged).toBe(b.staged); });
  it('synthesize is deterministic', async () => { const a = await run('synthesize', { finding: 'x' }); const b = await run('synthesize', { finding: 'x' }); expect(a.staged).toBe(b.staged); expect(a.staged).toContain('Deterministic synthesis complete'); });
});
