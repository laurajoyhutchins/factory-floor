import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryDirectories = [];

function makeTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'ff-ci-accounting-'));
  temporaryDirectories.push(directory);
  return directory;
}

function runSummary(stages, files) {
  const directory = makeTemporaryDirectory();
  const metrics = join(directory, 'metrics');
  const tests = join(directory, 'tests');
  const output = join(directory, 'summary.json');
  mkdirSync(metrics);
  mkdirSync(tests);
  for (const stage of stages) {
    writeFileSync(
      join(metrics, `${stage}.json`),
      JSON.stringify({
        stage,
        success: true,
        exitCode: 0,
        durationSeconds: 1,
      }),
    );
  }
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(tests, name), content);
  }
  const result = spawnSync(
    process.execPath,
    [
      'scripts/summarize-ci-metrics.mjs',
      '--metrics',
      metrics,
      '--tests',
      tests,
      '--output',
      output,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  return { result, summary: JSON.parse(readFileSync(output, 'utf8')) };
}

function junit(classname, name) {
  return `<testsuites tests="1" failures="0" errors="0" skipped="0" time="0.1"><testsuite tests="1"><testcase classname="${classname}" name="${name}" time="0.1" /></testsuite></testsuites>`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CI test accounting', () => {
  it('rejects duplicate test identities across JUnit files', () => {
    const duplicate = junit('tests.test_client', 'test_claim');
    const { result, summary } = runSummary(['unit'], {
      'worker-sdk-py.xml': duplicate,
      'demo-py.xml': duplicate,
    });
    expect(result.status).toBe(1);
    expect(summary.validation.duplicateTests).toEqual([
      'tests.test_client::test_claim',
    ]);
  });

  it('rejects a completed stage with no required test layer', () => {
    const { result, summary } = runSummary(['integration'], {});
    expect(result.status).toBe(1);
    expect(summary.validation.missingLayers).toEqual(['integration']);
  });

  it('resets the database after integration failure and preserves the failure', () => {
    const directory = makeTemporaryDirectory();
    const bin = join(directory, 'bin');
    const log = join(directory, 'pnpm.log');
    const pnpm = join(bin, 'pnpm');
    mkdirSync(bin);
    writeFileSync(
      pnpm,
      `#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$FACTORY_FLOOR_TEST_COMMAND_LOG"
if [[ "$*" == "test:integration" ]]; then
  exit 17
fi
exit 0
`,
    );
    chmodSync(pnpm, 0o755);

    const result = spawnSync('bash', ['scripts/verify.sh', 'integration'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CI: 'false',
        FACTORY_FLOOR_TEST_COMMAND_LOG: log,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });

    expect(result.status).toBe(17);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'typecheck',
      'test:integration',
      'db:reset',
    ]);
  });

  it('keeps canonical suites non-overlapping and fail-closed', () => {
    const packageJson = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    );
    const pyproject = readFileSync(
      join(root, 'packages/worker-sdk-py/pyproject.toml'),
      'utf8',
    );
    const integrationConfig = readFileSync(
      join(root, 'vitest.integration.config.ts'),
      'utf8',
    );
    const verifyScript = readFileSync(join(root, 'scripts/verify.sh'), 'utf8');
    expect(pyproject).toContain('testpaths = ["tests"]');
    expect(pyproject).not.toContain('../../workers/demo-py/tests');
    expect(packageJson.scripts['test:python']).toContain(
      'pytest packages/worker-sdk-py/tests',
    );
    expect(packageJson.scripts['test:python']).toContain(
      'pytest workers/demo-py/tests',
    );
    expect(packageJson.scripts['test:python:ci']).toContain(
      'pytest packages/worker-sdk-py/tests',
    );
    expect(packageJson.scripts['test:python:ci']).toContain(
      'pytest workers/demo-py/tests',
    );
    expect(integrationConfig).toContain('passWithNoTests: false');
    expect(packageJson.scripts['test:integration:ci']).toContain(
      'vitest-integration.xml',
    );
    expect(packageJson.scripts['test:acceptance:ci']).toContain(
      'vitest-acceptance.xml',
    );
    expect(verifyScript).toContain('pnpm test:integration:ci');
    expect(verifyScript).toContain('pnpm test:acceptance:ci');
  });
});
