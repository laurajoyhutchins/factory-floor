import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

import { findActionableError } from './write-agent-ci-summary.mjs';

const script = new URL('./write-agent-ci-summary.mjs', import.meta.url);
const temporaryDirectories = [];

const makeTemporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-ci-summary-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('agent CI summary', () => {
  it('ignores zero-error summaries', () => {
    expect(findActionableError('0 errors\nTypeError: broken adapter')).toBe(
      'TypeError: broken adapter',
    );
  });

  it('ignores failure words in file paths', () => {
    expect(
      findActionableError(
        '- contracts/schemas/failure-descriptor.schema.json\n[warn] Code style issues found in 3 files.',
      ),
    ).toBe('[warn] Code style issues found in 3 files.');
  });

  it('writes a failed handoff for the last started stage', () => {
    const directory = makeTemporaryDirectory();
    const manifest = join(directory, 'manifest.json');
    const output = join(directory, 'agent-ci-summary.json');
    writeFileSync(
      manifest,
      JSON.stringify({
        stages: [
          {
            name: 'format',
            command: 'pnpm format:check',
            logs: [join(directory, 'format.log')],
          },
          {
            name: 'test',
            command: 'pnpm test',
            logs: [join(directory, 'test.log')],
          },
          {
            name: 'build',
            command: 'pnpm build',
            logs: [join(directory, 'build.log')],
          },
        ],
      }),
    );
    writeFileSync(join(directory, 'format.log'), 'Formatting passed\n');
    writeFileSync(
      join(directory, 'test.log'),
      'FAIL src/example.test.ts\nAssertionError: expected true\n',
    );

    const result = spawnSync(
      process.execPath,
      [
        script.pathname,
        '--manifest',
        manifest,
        '--output',
        output,
        '--job',
        'test',
        '--artifact',
        'test-evidence',
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT_CI_JOB_STATUS: 'failure',
          AGENT_CI_HEAD_SHA: 'head-sha',
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_JOB: 'test',
          GITHUB_SHA: 'verification-sha',
          GITHUB_WORKFLOW: 'CI',
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(output, 'utf8'));
    expect(summary.headSha).toBe('head-sha');
    expect(summary.verificationSha).toBe('verification-sha');
    expect(summary.failedStage).toBe('test');
    expect(summary.firstActionableError).toBe('FAIL src/example.test.ts');
    expect(summary.reproductionCommand).toBe('pnpm test');
    expect(summary.artifacts).toEqual(['test-evidence']);
    expect(summary.runUrl).toBe(
      'https://github.com/owner/repo/actions/runs/123',
    );
  });

  it('writes a successful handoff without a false failure', () => {
    const directory = makeTemporaryDirectory();
    const manifest = join(directory, 'manifest.json');
    const output = join(directory, 'agent-ci-summary.json');
    writeFileSync(
      manifest,
      JSON.stringify({
        stages: [
          {
            name: 'check',
            command: 'pnpm check',
            logs: [join(directory, 'check.log')],
          },
        ],
      }),
    );
    writeFileSync(
      join(directory, 'check.log'),
      '0 errors\nAll checks passed\n',
    );

    const result = spawnSync(
      process.execPath,
      [
        script.pathname,
        '--manifest',
        manifest,
        '--output',
        output,
        '--job',
        'check',
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, AGENT_CI_JOB_STATUS: 'success' },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(output, 'utf8'));
    expect(summary.failedStage).toBeNull();
    expect(summary.firstActionableError).toBeNull();
    expect(summary.stages[0].result).toBe('passed');
  });
});
