import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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

test('accepts the repository worker SDK conformance corpus', () => {
  const result = validateWorkerSdkConformance({ corpus, schema, repoRoot });
  assert.deepEqual(result.errors, []);
  assert.equal(result.evidence.caseCount, corpus.cases.length);
  assert.deepEqual(
    result.evidence.implementations.map((item) => item.language),
    ['typescript', 'python'],
  );
});

test('rejects missing cases, fixtures, and canonical alias drift', () => {
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
  assert.ok(
    result.errors.some((error) =>
      error.includes('missing required case: result.duplicate-conflict'),
    ),
  );
  assert.ok(result.errors.some((error) => error.includes('missing fixture')));
  assert.ok(
    result.errors.some((error) =>
      error.includes('must not reach the canonical wire body'),
    ),
  );
});
