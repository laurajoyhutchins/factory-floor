import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const corpusUrl = new URL(
  '../../../contracts/conformance/worker-protocol-v1.cases.json',
  import.meta.url,
);

const requiredCaseIds = [
  'claim.claimed',
  'claim.no-work',
  'claim.deprecated-capabilities',
  'heartbeat.lease-error',
  'cancellation.stale-epoch',
  'artifact.stage-upload',
  'capability.denied',
  'result.accepted',
  'result.duplicate-identical',
  'result.duplicate-conflict',
  'response.malformed',
  'transport.retryable',
] as const;

type ConformanceCase = {
  id: string;
  operation: string;
  expected: {
    classification: string;
    retryable: boolean;
  };
};

type ConformanceCorpus = {
  schemaVersion: 1;
  protocolVersion: '1.0';
  cases: ConformanceCase[];
};

function loadCorpus(): ConformanceCorpus {
  return JSON.parse(readFileSync(corpusUrl, 'utf8')) as ConformanceCorpus;
}

describe('worker protocol conformance corpus', () => {
  it('defines one unique, complete case set for the TypeScript SDK', () => {
    const corpus = loadCorpus();
    const ids = corpus.cases.map((testCase) => testCase.id);

    expect(corpus.schemaVersion).toBe(1);
    expect(corpus.protocolVersion).toBe('1.0');
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([...requiredCaseIds]));
    for (const testCase of corpus.cases) {
      expect(testCase.operation).not.toBe('');
      expect(testCase.expected.classification).not.toBe('');
      expect(typeof testCase.expected.retryable).toBe('boolean');
    }
  });
});
