import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const errors = [];

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function requirePath(path, label = path) {
  if (!existsSync(join(root, path)))
    errors.push(`${label} is missing: ${path}`);
}

const packageJson = JSON.parse(read('package.json'));
const scripts = packageJson.scripts ?? {};
if ('dev:services' in scripts)
  errors.push('remove duplicate dev:services; use services:up');
if (scripts['services:up'] !== 'docker compose up -d postgres minio')
  errors.push(
    'services:up must remain the canonical development service start command',
  );

const completedPlan =
  '.agents/plans/2026-07-19-template-instantiation-inspection.md';
if (existsSync(join(root, completedPlan)))
  errors.push(
    `completed implementation plan must remain retired: ${completedPlan}`,
  );

const recovery = read(
  'packages/runtime-core/src/observability/recovery-service.ts',
);
if (!recovery.includes('projectionsExpected: PROJECTION_NAMES.length'))
  errors.push(
    'startup recovery must derive projection expectations from PROJECTION_NAMES',
  );
if (recovery.includes('checkpointed: 10 as const'))
  errors.push(
    'startup recovery contains the retired hardcoded projection count',
  );

const ledgerPath = 'docs/reference/worker-protocol-compatibility.md';
requirePath(ledgerPath);
if (existsSync(join(root, ledgerPath))) {
  const ledger = read(ledgerPath);
  for (const alias of [
    'WORKER-V1-PY-CLAIM-CAPABILITIES',
    'WORKER-V1-TS-REGISTRY-CAPABILITIES',
  ]) {
    if (!ledger.includes(alias))
      errors.push(`compatibility ledger omits ${alias}`);
  }
  if (!ledger.includes('issue #107'))
    errors.push('compatibility ledger must link the protocol v2 removal issue');
}

for (const evidence of [
  'contracts/conformance/worker-protocol-v1.cases.json',
  'packages/worker-sdk-py/tests/test_conformance_claim.py',
  'packages/worker-sdk-ts/test/deprecation-compatibility.test.ts',
])
  requirePath(evidence, 'compatibility evidence');

if (errors.length > 0) {
  globalThis.console.error('Repository drift check failed:');
  for (const error of errors) globalThis.console.error(`- ${error}`);
  process.exit(1);
}

globalThis.console.log(
  'Repository drift check passed: canonical services command, projection count, retired plan, and protocol aliases are guarded.',
);
