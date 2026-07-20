import Ajv2020 from 'ajv/dist/2020.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUIRED_CASE_IDS = new Set([
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
]);

const IMPLEMENTATIONS = [
  {
    language: 'typescript',
    package: 'packages/worker-sdk-ts',
    adapters: [
      'packages/worker-sdk-ts/test/conformance-claim.test.ts',
      'packages/worker-sdk-ts/test/conformance-operations.test.ts',
    ],
  },
  {
    language: 'python',
    package: 'packages/worker-sdk-py',
    adapters: [
      'packages/worker-sdk-py/tests/test_conformance_claim.py',
      'packages/worker-sdk-py/tests/test_conformance_operations.py',
    ],
  },
];

function fixtureReferences(testCase) {
  return [
    testCase.request?.fixture,
    testCase.response?.fixture,
    testCase.response?.successFixture,
    testCase.response?.body?.envelopeFixture,
  ].filter((value) => typeof value === 'string');
}

function isRepoPath(repoRoot, value) {
  if (isAbsolute(value)) return false;
  const absolute = resolve(repoRoot, value);
  const fromRoot = relative(repoRoot, absolute);
  return fromRoot !== '..' && !fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

export function validateWorkerSdkConformance({
  corpus,
  schema,
  repoRoot,
  fileExists = existsSync,
}) {
  const errors = [];
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(corpus))
    for (const error of validate.errors ?? [])
      errors.push(`${error.instancePath || '/'} ${error.message}`);

  const caseIds = corpus.cases?.map((testCase) => testCase.id) ?? [];
  const uniqueCaseIds = new Set(caseIds);
  if (uniqueCaseIds.size !== caseIds.length) errors.push('case ids must be unique');
  for (const required of REQUIRED_CASE_IDS)
    if (!uniqueCaseIds.has(required)) errors.push(`missing required case: ${required}`);

  const fixturePaths = new Set();
  for (const testCase of corpus.cases ?? [])
    for (const fixturePath of fixtureReferences(testCase)) {
      fixturePaths.add(fixturePath);
      if (!isRepoPath(repoRoot, fixturePath))
        errors.push(`${testCase.id}: fixture must stay within the repository`);
      else if (!fileExists(resolve(repoRoot, fixturePath)))
        errors.push(`${testCase.id}: missing fixture ${fixturePath}`);
    }

  for (const implementation of IMPLEMENTATIONS)
    for (const adapter of implementation.adapters)
      if (!fileExists(resolve(repoRoot, adapter)))
        errors.push(`${implementation.language}: missing adapter ${adapter}`);

  const deprecated = (corpus.cases ?? []).find(
    (testCase) => testCase.id === 'claim.deprecated-capabilities',
  );
  if (deprecated) {
    if (deprecated.request.sdkInputAlias !== 'capabilities')
      errors.push('claim.deprecated-capabilities must name the deprecated alias');
    if (deprecated.request.expectedWireBody?.capabilities !== undefined)
      errors.push('deprecated capabilities must not reach the canonical wire body');
    if (
      JSON.stringify(deprecated.request.componentSelectors) !==
      JSON.stringify(deprecated.request.expectedWireBody?.componentSelectors)
    )
      errors.push('deprecated capabilities must normalize to componentSelectors');
  }

  const classificationCounts = {};
  for (const testCase of corpus.cases ?? []) {
    const classification = testCase.expected?.classification;
    if (typeof classification === 'string')
      classificationCounts[classification] =
        (classificationCounts[classification] ?? 0) + 1;
  }

  return {
    errors,
    evidence: {
      schemaVersion: corpus.schemaVersion,
      protocolVersion: corpus.protocolVersion,
      caseCount: caseIds.length,
      caseIds: [...caseIds].sort(),
      classificationCounts,
      fixturePaths: [...fixturePaths].sort(),
      implementations: IMPLEMENTATIONS,
    },
  };
}

function main() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const corpusPath = resolve(
    repoRoot,
    'contracts/conformance/worker-protocol-v1.cases.json',
  );
  const schemaPath = resolve(
    repoRoot,
    'contracts/conformance/worker-protocol-v1.cases.schema.json',
  );
  const outputPath = resolve(
    repoRoot,
    '.factory-floor/ci-metrics/worker-sdk-conformance.json',
  );
  const result = validateWorkerSdkConformance({
    corpus: JSON.parse(readFileSync(corpusPath, 'utf8')),
    schema: JSON.parse(readFileSync(schemaPath, 'utf8')),
    repoRoot,
  });

  if (result.errors.length > 0) {
    globalThis.console.error('Worker SDK conformance check failed:');
    for (const error of result.errors) globalThis.console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result.evidence, null, 2)}\n`);
  globalThis.console.log(
    `Worker SDK conformance corpus passed: ${result.evidence.caseCount} cases across ${result.evidence.implementations.length} SDKs.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
