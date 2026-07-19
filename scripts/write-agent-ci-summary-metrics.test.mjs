import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildSummary } from './write-agent-ci-summary.mjs';

const temporaryDirectories = [];

const makeTemporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-ci-metrics-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const environment = {
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_RUN_ID: '123',
  GITHUB_JOB: 'service-verification',
  GITHUB_SHA: 'verification-sha',
  AGENT_CI_HEAD_SHA: 'head-sha',
};

describe('agent CI summary metric attribution', () => {
  it('uses the failed stage metric instead of the last log that exists', () => {
    const directory = makeTemporaryDirectory();
    const servicesMetric = join(directory, 'services.json');
    const integrationMetric = join(directory, 'integration.json');
    const acceptanceMetric = join(directory, 'acceptance.json');
    const servicesLog = join(directory, 'services.log');
    const integrationLog = join(directory, 'integration.log');
    const acceptanceLog = join(directory, 'acceptance.log');

    writeFileSync(
      servicesMetric,
      JSON.stringify({ stage: 'services', success: true, exitCode: 0 }),
    );
    writeFileSync(
      integrationMetric,
      JSON.stringify({ stage: 'integration', success: false, exitCode: 1 }),
    );
    writeFileSync(
      acceptanceMetric,
      JSON.stringify({ stage: 'acceptance', success: true, exitCode: 0 }),
    );
    writeFileSync(servicesLog, 'services passed\n');
    writeFileSync(integrationLog, 'FAIL integration contract\n');
    writeFileSync(acceptanceLog, 'acceptance passed\n');

    const summary = buildSummary({
      manifest: {
        stages: [
          {
            name: 'services',
            command: 'pnpm verify:services',
            metric: servicesMetric,
            logs: [servicesLog],
          },
          {
            name: 'integration',
            command: 'pnpm verify:integration',
            metric: integrationMetric,
            logs: [integrationLog],
          },
          {
            name: 'acceptance',
            command: 'pnpm verify:acceptance',
            metric: acceptanceMetric,
            logs: [acceptanceLog],
          },
        ],
      },
      environment,
      jobStatus: 'failure',
      artifactName: 'service-evidence',
    });

    expect(summary.failureKind).toBe('verification-stage');
    expect(summary.failedStage).toBe('integration');
    expect(summary.firstActionableError).toBe('FAIL integration contract');
    expect(summary.reproductionCommand).toBe('pnpm verify:integration');
    expect(summary.stages).toEqual([
      expect.objectContaining({ name: 'services', result: 'passed' }),
      expect.objectContaining({ name: 'integration', result: 'failed' }),
      expect.objectContaining({ name: 'acceptance', result: 'passed' }),
    ]);
  });

  it('reports a later infrastructure failure without blaming a passing acceptance stage', () => {
    const directory = makeTemporaryDirectory();
    const acceptanceMetric = join(directory, 'acceptance.json');
    const acceptanceLog = join(directory, 'acceptance.log');
    const cleanupLog = join(directory, 'cleanup.log');

    writeFileSync(
      acceptanceMetric,
      JSON.stringify({ stage: 'acceptance', success: true, exitCode: 0 }),
    );
    writeFileSync(acceptanceLog, 'acceptance passed\n');
    writeFileSync(cleanupLog, 'Error: Docker cleanup failed\n');

    const summary = buildSummary({
      manifest: {
        stages: [
          {
            name: 'acceptance',
            command: 'pnpm verify:acceptance',
            metric: acceptanceMetric,
            logs: [acceptanceLog],
          },
        ],
      },
      environment,
      jobStatus: 'failure',
      artifactName: 'service-evidence',
      failureStep: {
        name: 'cleanup',
        command: 'pnpm services:clean',
        log: cleanupLog,
      },
    });

    expect(summary.failureKind).toBe('infrastructure');
    expect(summary.failedStage).toBe('cleanup');
    expect(summary.firstActionableError).toBe('Error: Docker cleanup failed');
    expect(summary.reproductionCommand).toBe('pnpm services:clean');
    expect(summary.stages).toEqual([
      expect.objectContaining({ name: 'acceptance', result: 'passed' }),
    ]);
  });
});
