import { spawnSync } from 'node:child_process';
import {
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

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'ff-coverage-summary-'));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, 'typescript'), { recursive: true });
  mkdirSync(join(directory, 'python-worker-sdk'), { recursive: true });
  mkdirSync(join(directory, 'python-demo'), { recursive: true });
  return directory;
}

function writeValidReports(directory) {
  writeFileSync(
    join(directory, 'typescript', 'coverage-summary.json'),
    JSON.stringify({
      total: {
        lines: { total: 100, covered: 80, skipped: 0, pct: 80 },
        statements: { total: 110, covered: 88, skipped: 0, pct: 80 },
        functions: { total: 20, covered: 15, skipped: 0, pct: 75 },
        branches: { total: 40, covered: 28, skipped: 0, pct: 70 },
      },
    }),
  );
  for (const [name, totals] of [
    [
      'python-worker-sdk',
      {
        covered_lines: 72,
        num_statements: 90,
        percent_covered: 80,
        covered_branches: 18,
        num_branches: 30,
      },
    ],
    [
      'python-demo',
      {
        covered_lines: 45,
        num_statements: 60,
        percent_covered: 75,
        covered_branches: 8,
        num_branches: 16,
      },
    ],
  ]) {
    writeFileSync(join(directory, name, 'coverage.json'), JSON.stringify({ totals }));
  }
}

function summarize(directory) {
  const output = join(directory, 'summary.json');
  const result = spawnSync(
    process.execPath,
    [
      'scripts/summarize-coverage.mjs',
      '--typescript',
      join(directory, 'typescript', 'coverage-summary.json'),
      '--python-worker-sdk',
      join(directory, 'python-worker-sdk', 'coverage.json'),
      '--python-demo',
      join(directory, 'python-demo', 'coverage.json'),
      '--output',
      output,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  return {
    result,
    output,
    summary: JSON.parse(readFileSync(output, 'utf8')),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('coverage evidence summary', () => {
  it('retains separate TypeScript and Python package metrics', () => {
    const directory = workspace();
    writeValidReports(directory);

    const { result, summary } = summarize(directory);

    expect(result.status, result.stderr).toBe(0);
    expect(summary).toMatchObject({
      schemaVersion: 1,
      thresholdEnforcement: false,
      sources: [
        {
          source: 'python-demo',
          language: 'python',
          lines: { total: 60, covered: 45, percent: 75 },
          branches: { total: 16, covered: 8, percent: 50 },
        },
        {
          source: 'python-worker-sdk',
          language: 'python',
          lines: { total: 90, covered: 72, percent: 80 },
          branches: { total: 30, covered: 18, percent: 60 },
        },
        {
          source: 'typescript',
          language: 'typescript',
          lines: { total: 100, covered: 80, percent: 80 },
          branches: { total: 40, covered: 28, percent: 70 },
          functions: { total: 20, covered: 15, percent: 75 },
          statements: { total: 110, covered: 88, percent: 80 },
        },
      ],
      validation: { errors: [] },
    });
    expect(result.stdout).toContain('| typescript | 80% | 70% | 75% | 80% |');
  });

  it('fails closed when an expected report is missing', () => {
    const directory = workspace();
    writeValidReports(directory);
    rmSync(join(directory, 'python-demo', 'coverage.json'));

    const { result, summary } = summarize(directory);

    expect(result.status).toBe(1);
    expect(summary.validation.errors).toEqual([
      expect.stringContaining('python-demo coverage report is missing'),
    ]);
  });

  it('fails closed when required totals are malformed', () => {
    const directory = workspace();
    writeValidReports(directory);
    writeFileSync(
      join(directory, 'typescript', 'coverage-summary.json'),
      JSON.stringify({ total: { lines: { total: 'invalid' } } }),
    );

    const { result, summary } = summarize(directory);

    expect(result.status).toBe(1);
    expect(summary.validation.errors).toEqual([
      expect.stringContaining('typescript lines total'),
    ]);
  });
});
