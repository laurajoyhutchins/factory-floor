import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateWorkerSdkConformance } from './check-worker-sdk-conformance.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    resolve(repoRoot, 'contracts/conformance/worker-protocol-v1.cases.json'),
    'utf8',
  ),
);
const schema = JSON.parse(
  readFileSync(
    resolve(
      repoRoot,
      'contracts/conformance/worker-protocol-v1.cases.schema.json',
    ),
    'utf8',
  ),
);

describe('worker SDK conformance corpus validation', () => {
  it('accepts the repository corpus', () => {
    const result = validateWorkerSdkConformance({ corpus, schema, repoRoot });
    expect(result.errors).toEqual([]);
    expect(result.evidence.caseCount).toBe(corpus.cases.length);
    expect(
      result.evidence.implementations.map((item) => item.language),
    ).toEqual(['typescript', 'python']);
  });

  it('rejects missing cases, fixtures, and canonical alias drift', () => {
    const invalid = JSON.parse(JSON.stringify(corpus));
    invalid.cases = invalid.cases.filter(
      (testCase) => testCase.id !== 'result.duplicate-conflict',
    );
    invalid.cases.find(
      (testCase) => testCase.id === 'claim.no-work',
    ).response.fixture = 'contracts/fixtures/worker/missing.json';
    invalid.cases.find(
      (testCase) => testCase.id === 'claim.deprecated-capabilities',
    ).request.expectedWireBody.capabilities = ['verify@1'];

    const result = validateWorkerSdkConformance({
      corpus: invalid,
      schema,
      repoRoot,
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'missing required case: result.duplicate-conflict',
        ),
        expect.stringContaining('missing fixture'),
        expect.stringContaining('must not reach the canonical wire body'),
      ]),
    );
  });

  it('rejects ambiguous request targets', () => {
    const invalid = JSON.parse(JSON.stringify(corpus));
    invalid.cases[0].request.endpointFromEnvelope = 'heartbeatUrl';

    const result = validateWorkerSdkConformance({
      corpus: invalid,
      schema,
      repoRoot,
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('oneOf')]),
    );
  });
});
