import console from 'node:console';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import process from 'node:process';

const usage =
  'Usage: node scripts/summarize-ci-metrics.mjs --metrics <directory> --tests <directory> --output <path>';

const layerByFilename = new Map([
  ['vitest-unit.xml', 'unit-ts'],
  ['worker-sdk-py.xml', 'python-worker-sdk'],
  ['demo-py.xml', 'python-demo'],
  ['vitest-integration.xml', 'integration'],
  ['vitest-acceptance.xml', 'acceptance'],
]);

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
    if (!existsSync(directory)) return [];
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

  const readAttribute = (attributes, name) =>
    attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
  const readNumericAttribute = (attributes, name) => {
    const value = Number(readAttribute(attributes, name));
    return Number.isFinite(value) ? value : 0;
  };
  const hasAttribute = (attributes, name) =>
    new RegExp(`(?:^|\\s)${name}="[^"]*"`).test(attributes);
  const numericAttributes = ['tests', 'failures', 'errors', 'skipped', 'time'];
  const emptyTotals = () => ({
    files: 0,
    tests: 0,
    failures: 0,
    errors: 0,
    skipped: 0,
    durationSeconds: 0,
  });
  const addAttributes = (totals, attributes) => {
    totals.tests += readNumericAttribute(attributes, 'tests');
    totals.failures += readNumericAttribute(attributes, 'failures');
    totals.errors += readNumericAttribute(attributes, 'errors');
    totals.skipped += readNumericAttribute(attributes, 'skipped');
    totals.durationSeconds += readNumericAttribute(attributes, 'time');
  };
  const layerForPath = (path) => {
    const name = basename(path);
    return (
      layerByFilename.get(name) ??
      `other:${name.slice(0, -extname(name).length)}`
    );
  };

  const testTotals = emptyTotals();
  const layerTotals = new Map();
  const identityFiles = new Map();

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

    const layer = layerForPath(path);
    const perLayer = layerTotals.get(layer) ?? emptyTotals();
    testTotals.files += 1;
    perLayer.files += 1;
    for (const attributes of attributeGroups) {
      addAttributes(testTotals, attributes);
      addAttributes(perLayer, attributes);
    }
    layerTotals.set(layer, perLayer);

    for (const match of xml.matchAll(/<testcase\b([^>]*)>/gi)) {
      const classname = readAttribute(match[1], 'classname') ?? '';
      const name = readAttribute(match[1], 'name') ?? '';
      if (!name) continue;
      const identity = `${classname}::${name}`;
      const files = identityFiles.get(identity) ?? new Set();
      files.add(path);
      identityFiles.set(identity, files);
    }
  }

  const roundDuration = (totals) => {
    totals.durationSeconds = Number(totals.durationSeconds.toFixed(3));
    return totals;
  };
  roundDuration(testTotals);
  const layers = [...layerTotals]
    .map(([layer, totals]) => ({ layer, ...roundDuration(totals) }))
    .sort((left, right) => left.layer.localeCompare(right.layer));

  const stageNames = new Set(stages.map((stage) => stage.stage));
  const requiredLayers = new Set();
  if (
    stageNames.has('unit') ||
    [...stageNames].some((name) => name.endsWith('-unit'))
  ) {
    requiredLayers.add('unit-ts');
    requiredLayers.add('python-worker-sdk');
    requiredLayers.add('python-demo');
  }
  if (
    stageNames.has('integration') ||
    [...stageNames].some((name) => name.endsWith('-integration'))
  ) {
    requiredLayers.add('integration');
  }
  if (stageNames.has('acceptance')) requiredLayers.add('acceptance');

  const duplicateTests = [...identityFiles]
    .filter(([, files]) => files.size > 1)
    .map(([identity]) => identity)
    .sort();
  const missingLayers = [...requiredLayers]
    .filter((layer) => !layerTotals.has(layer))
    .sort();
  const zeroTestLayers = [...requiredLayers]
    .filter((layer) => (layerTotals.get(layer)?.tests ?? 0) === 0)
    .filter((layer) => !missingLayers.includes(layer))
    .sort();
  const validation = { duplicateTests, missingLayers, zeroTestLayers };

  const summary = {
    schemaVersion: 2,
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
    tests: { ...testTotals, layers },
    validation,
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
    '| Test layer | Files | Tests | Failures | Errors | Skipped | Seconds |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...layers.map(
      (layer) =>
        `| ${layer.layer} | ${layer.files} | ${layer.tests} | ${layer.failures} | ${layer.errors} | ${layer.skipped} | ${layer.durationSeconds} |`,
    ),
    `| **Total** | **${summary.tests.files}** | **${summary.tests.tests}** | **${summary.tests.failures}** | **${summary.tests.errors}** | **${summary.tests.skipped}** | **${summary.tests.durationSeconds}** |`,
  ];

  if (duplicateTests.length > 0) {
    lines.push('', `Duplicate test identities: ${duplicateTests.join(', ')}`);
  }
  if (missingLayers.length > 0) {
    lines.push('', `Missing required test layers: ${missingLayers.join(', ')}`);
  }
  if (zeroTestLayers.length > 0) {
    lines.push(
      '',
      `Required test layers with zero tests: ${zeroTestLayers.join(', ')}`,
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  if (
    duplicateTests.length > 0 ||
    missingLayers.length > 0 ||
    zeroTestLayers.length > 0
  ) {
    process.exitCode = 1;
  }
}
