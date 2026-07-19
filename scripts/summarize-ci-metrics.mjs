import console from 'node:console';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const usage =
  'Usage: node scripts/summarize-ci-metrics.mjs --metrics <directory> --tests <directory> --output <path>';

const readOption = (name) => {
  const index = process.argv.indexOf(name, 2);
  return index === -1 ? undefined : process.argv[index + 1];
};

const metricsDirectory = readOption('--metrics');
const testsDirectory = readOption('--tests');
const output = readOption('--output');

if (!metricsDirectory || !testsDirectory || !output) {
  console.error(usage);
  process.exitCode = 2;
} else {
  const listFiles = (directory, suffix) => {
    if (!existsSync(directory)) {
      return [];
    }

    return readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
          ? listFiles(path, suffix)
          : entry.isFile() && path.endsWith(suffix)
            ? [path]
            : [];
      })
      .sort();
  };

  const outputPath = resolve(output);
  const stages = listFiles(resolve(metricsDirectory), '.json')
    .filter((path) => resolve(path) !== outputPath)
    .flatMap((path) => {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return typeof value.stage === 'string' ? [value] : [];
      } catch (error) {
        console.error(
          `Ignoring invalid metric ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    })
    .sort((left, right) => left.stage.localeCompare(right.stage));

  const readNumericAttribute = (attributes, name) => {
    const match = attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]+)"`));
    if (!match) {
      return 0;
    }
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : 0;
  };

  const hasAttribute = (attributes, name) =>
    new RegExp(`(?:^|\\s)${name}="[^"]*"`).test(attributes);
  const numericAttributes = [
    'tests',
    'failures',
    'errors',
    'skipped',
    'time',
  ];

  const testTotals = {
    files: 0,
    tests: 0,
    failures: 0,
    errors: 0,
    skipped: 0,
    durationSeconds: 0,
  };

  for (const path of listFiles(resolve(testsDirectory), '.xml')) {
    const xml = readFileSync(path, 'utf8');
    const aggregateRoot = xml.match(/<testsuites\b([^>]*)>/i);
    const singleRoot = xml.match(/<testsuite\b([^>]*)>/i);
    let attributeGroups = [];

    if (
      aggregateRoot &&
      numericAttributes.some((name) => hasAttribute(aggregateRoot[1], name))
    ) {
      attributeGroups = [aggregateRoot[1]];
    } else if (aggregateRoot) {
      attributeGroups = [...xml.matchAll(/<testsuite\b([^>]*)>/gi)].map(
        (match) => match[1],
      );
    } else if (singleRoot) {
      attributeGroups = [singleRoot[1]];
    }

    if (attributeGroups.length === 0) {
      console.error(`Ignoring JUnit file without test-suite totals: ${path}`);
      continue;
    }

    testTotals.files += 1;
    for (const attributes of attributeGroups) {
      testTotals.tests += readNumericAttribute(attributes, 'tests');
      testTotals.failures += readNumericAttribute(attributes, 'failures');
      testTotals.errors += readNumericAttribute(attributes, 'errors');
      testTotals.skipped += readNumericAttribute(attributes, 'skipped');
      testTotals.durationSeconds += readNumericAttribute(attributes, 'time');
    }
  }
  testTotals.durationSeconds = Number(testTotals.durationSeconds.toFixed(3));

  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    stages: stages.map((stage) => ({
      stage: stage.stage,
      success: stage.success === true,
      exitCode: stage.exitCode ?? null,
      durationSeconds: Number(stage.durationSeconds ?? 0),
      startedAt: stage.startedAt ?? null,
      completedAt: stage.completedAt ?? null,
      github: stage.github ?? null,
    })),
    tests: testTotals,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);

  const lines = [
    '## CI verification metrics',
    '',
    '| Stage | Result | Seconds |',
    '| --- | --- | ---: |',
    ...summary.stages.map(
      (stage) =>
        `| ${stage.stage} | ${stage.success ? 'passed' : 'failed'} | ${stage.durationSeconds} |`,
    ),
    '',
    '| Test result | Count |',
    '| --- | ---: |',
    `| Files | ${summary.tests.files} |`,
    `| Tests | ${summary.tests.tests} |`,
    `| Failures | ${summary.tests.failures} |`,
    `| Errors | ${summary.tests.errors} |`,
    `| Skipped | ${summary.tests.skipped} |`,
    `| Seconds | ${summary.tests.durationSeconds} |`,
  ];

  process.stdout.write(`${lines.join('\n')}\n`);
}
