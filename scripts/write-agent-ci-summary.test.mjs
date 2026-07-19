import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findActionableError } from './write-agent-ci-summary.mjs';

const script = fileURLToPath(new URL('./write-agent-ci-summary.mjs', import.meta.url));

const withTemp = (callback) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-ci-summary-'));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test('findActionableError ignores zero-error summaries', () => {
  assert.equal(findActionableError('0 errors\nTypeError: broken adapter'), 'TypeError: broken adapter');
});

test('writes a failed handoff for the last started stage', () => {
  withTemp((directory) => {
    const manifest = join(directory, 'manifest.json');
    const output = join(directory, 'agent-ci-summary.json');
    writeFileSync(
      manifest,
      JSON.stringify({
        stages: [
          { name: 'format', command: 'npm run format:check', logs: [join(directory, 'format.log')] },
          { name: 'test', command: 'npm test', logs: [join(directory, 'test.log')] },
          { name: 'build', command: 'npm run build', logs: [join(directory, 'build.log')] },
        ],
      }),
    );
    writeFileSync(join(directory, 'format.log'), 'Formatting passed\n');
    writeFileSync(join(directory, 'test.log'), 'FAIL src/example.test.ts\nAssertionError: expected true\n');

    const result = spawnSync(
      process.execPath,
      [script, '--manifest', manifest, '--output', output, '--job', 'test', '--artifact', 'test-evidence'],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT_CI_JOB_STATUS: 'failure',
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_JOB: 'test',
          GITHUB_SHA: '0123456789abcdef',
          GITHUB_WORKFLOW: 'CI',
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(summary.failedStage, 'test');
    assert.equal(summary.firstActionableError, 'FAIL src/example.test.ts');
    assert.equal(summary.reproductionCommand, 'npm test');
    assert.deepEqual(summary.artifacts, ['test-evidence']);
    assert.equal(summary.runUrl, 'https://github.com/owner/repo/actions/runs/123');
  });
});

test('writes a successful handoff without a false failure', () => {
  withTemp((directory) => {
    const manifest = join(directory, 'manifest.json');
    const output = join(directory, 'agent-ci-summary.json');
    writeFileSync(
      manifest,
      JSON.stringify({
        stages: [
          { name: 'check', command: 'pnpm check', logs: [join(directory, 'check.log')] },
        ],
      }),
    );
    writeFileSync(join(directory, 'check.log'), '0 errors\nAll checks passed\n');

    const result = spawnSync(
      process.execPath,
      [script, '--manifest', manifest, '--output', output, '--job', 'check'],
      {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, AGENT_CI_JOB_STATUS: 'success' },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(summary.failedStage, null);
    assert.equal(summary.firstActionableError, null);
    assert.equal(summary.stages[0].result, 'passed');
  });
});
