import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const temporaryDirectories = [];

const makeTemporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-floor-ci-quality-'));
  temporaryDirectories.push(directory);
  return directory;
};

const runNode = (arguments_, options = {}) =>
  spawnSync(process.execPath, arguments_, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CI stage metrics', () => {
  it('records a successful command with attributable GitHub metadata', () => {
    const directory = makeTemporaryDirectory();
    const output = join(directory, 'success.json');
    const result = runNode(
      [
        'scripts/run-ci-stage.mjs',
        '--stage',
        'fixture-success',
        '--output',
        output,
        '--',
        process.execPath,
        '-e',
        'process.exit(0)',
      ],
      {
        env: {
          ...process.env,
          GITHUB_RUN_ID: '1234',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_JOB: 'fast-verification',
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_REF: 'refs/pull/55/merge',
          GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const metric = JSON.parse(readFileSync(output, 'utf8'));
    expect(metric).toMatchObject({
      schemaVersion: 1,
      stage: 'fixture-success',
      command: [process.execPath, '-e', 'process.exit(0)'],
      success: true,
      exitCode: 0,
      signal: null,
      github: {
        runId: '1234',
        runAttempt: '2',
        job: 'fast-verification',
        eventName: 'pull_request',
        ref: 'refs/pull/55/merge',
        sha: '0123456789abcdef0123456789abcdef01234567',
      },
    });
    expect(metric.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(metric.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(metric.durationMilliseconds).toBeGreaterThanOrEqual(0);
    expect(metric.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('preserves a failing command status after writing diagnostics', () => {
    const directory = makeTemporaryDirectory();
    const output = join(directory, 'failure.json');
    const result = runNode([
      'scripts/run-ci-stage.mjs',
      '--stage',
      'fixture-failure',
      '--output',
      output,
      '--',
      process.execPath,
      '-e',
      'process.exit(7)',
    ]);

    expect(result.status).toBe(7);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      stage: 'fixture-failure',
      success: false,
      exitCode: 7,
      signal: null,
    });
  });
});

describe('CI metrics summary', () => {
  it('aggregates stage metrics and JUnit totals into JSON and Markdown', () => {
    const directory = makeTemporaryDirectory();
    const metricsDirectory = join(directory, 'metrics');
    const testsDirectory = join(directory, 'tests');
    const output = join(directory, 'summary.json');
    mkdirSync(metricsDirectory, { recursive: true });
    mkdirSync(testsDirectory, { recursive: true });

    writeFileSync(
      join(metricsDirectory, 'unit.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        stage: 'unit',
        success: true,
        exitCode: 0,
        durationMilliseconds: 1250,
        durationSeconds: 1.25,
      })}\n`,
    );
    writeFileSync(
      join(testsDirectory, 'vitest.xml'),
      '<testsuites tests="3" failures="1" errors="0" skipped="1" time="1.5"></testsuites>',
    );
    writeFileSync(
      join(testsDirectory, 'pytest.xml'),
      '<testsuites name="pytest tests"><testsuite tests="2" failures="0" errors="1" skipped="0" time="0.5"></testsuite></testsuites>',
    );

    const result = runNode([
      'scripts/summarize-ci-metrics.mjs',
      '--metrics',
      metricsDirectory,
      '--tests',
      testsDirectory,
      '--output',
      output,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('| unit | passed | 1.25 |');
    expect(result.stdout).toContain('| Tests | 5 |');
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      stages: [
        {
          stage: 'unit',
          success: true,
          durationSeconds: 1.25,
        },
      ],
      tests: {
        files: 2,
        tests: 5,
        failures: 1,
        errors: 1,
        skipped: 1,
        durationSeconds: 2,
      },
    });
  });
});

describe('repository CI quality policy', () => {
  it('accepts the checked-in policy and workflow', () => {
    const result = runNode(['scripts/check-ci-quality-gates.mjs']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('CI quality gates are valid');
  });

  it('rejects an invalid quality policy', () => {
    const directory = makeTemporaryDirectory();
    const policyPath = join(directory, 'quality-gates.json');
    const policy = JSON.parse(
      readFileSync(new URL('../quality-gates.json', import.meta.url), 'utf8'),
    );
    writeFileSync(
      policyPath,
      `${JSON.stringify({ ...policy, schemaVersion: 2 }, null, 2)}\n`,
    );

    const result = runNode([
      'scripts/check-ci-quality-gates.mjs',
      '--policy',
      policyPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('schemaVersion must be 1');
  });

  it('rejects a floating GitHub Action reference', () => {
    const directory = makeTemporaryDirectory();
    const workflowPath = join(directory, 'repository-verification.yml');
    const workflow = readFileSync(
      new URL(
        '../.github/workflows/repository-verification.yml',
        import.meta.url,
      ),
      'utf8',
    ).replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v4');
    writeFileSync(workflowPath, workflow);

    const result = runNode([
      'scripts/check-ci-quality-gates.mjs',
      '--workflow',
      workflowPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Action reference must use an immutable 40-character SHA: actions/checkout@v4',
    );
  });

  it('records enforceable targets separately from future ratchets', () => {
    const policy = JSON.parse(
      readFileSync(new URL('../quality-gates.json', import.meta.url), 'utf8'),
    );

    expect(policy).toMatchObject({
      schemaVersion: 1,
      durationTargetsSeconds: {
        fastVerificationP95: 120,
        completeVerificationP95: 600,
      },
      reliabilityTargets: {
        maximumFlakyRerunPercent: 0.5,
      },
      futureCoverageRatchet: {
        changedLinesPercent: 90,
        changedBranchesPercent: 85,
        totalCoverageMustNotDecrease: true,
        enforced: false,
      },
      changeReviewThresholds: {
        executableLines: 1000,
        files: 20,
      },
      supplyChain: {
        requireImmutableActionReferences: true,
      },
    });
  });
});
