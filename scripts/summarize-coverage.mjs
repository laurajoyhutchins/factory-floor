import console from 'node:console';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const usage =
  'Usage: node scripts/summarize-coverage.mjs --typescript <coverage-summary.json> --python-worker-sdk <coverage.json> --python-demo <coverage.json> --output <summary.json>';

function option(name) {
  const index = process.argv.indexOf(name, 2);
  return index === -1 ? undefined : process.argv[index + 1];
}

const paths = {
  typescript: option('--typescript'),
  'python-worker-sdk': option('--python-worker-sdk'),
  'python-demo': option('--python-demo'),
};
const output = option('--output');

if (Object.values(paths).some((value) => !value) || !output) {
  console.error(usage);
  process.exitCode = 2;
} else {
  const errors = [];
  const sources = [];

  function readReport(source, path) {
    if (!existsSync(path)) {
      errors.push(`${source} coverage report is missing: ${path}`);
      return null;
    }
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      errors.push(
        `${source} coverage report is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  function metric(source, name, total, covered, percent) {
    for (const [field, value] of [
      ['total', total],
      ['covered', covered],
      ['percent', percent],
    ]) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${source} ${name} ${field} must be a finite number`);
      }
    }
    if (
      typeof total !== 'number' ||
      typeof covered !== 'number' ||
      typeof percent !== 'number'
    ) {
      return { total: 0, covered: 0, percent: 0 };
    }
    return {
      total,
      covered,
      percent: Number(percent.toFixed(2)),
    };
  }

  const typescript = readReport('typescript', paths.typescript);
  if (typescript) {
    const total = typescript.total ?? {};
    sources.push({
      source: 'typescript',
      language: 'typescript',
      lines: metric(
        'typescript',
        'lines',
        total.lines?.total,
        total.lines?.covered,
        total.lines?.pct,
      ),
      branches: metric(
        'typescript',
        'branches',
        total.branches?.total,
        total.branches?.covered,
        total.branches?.pct,
      ),
      functions: metric(
        'typescript',
        'functions',
        total.functions?.total,
        total.functions?.covered,
        total.functions?.pct,
      ),
      statements: metric(
        'typescript',
        'statements',
        total.statements?.total,
        total.statements?.covered,
        total.statements?.pct,
      ),
    });
  }

  for (const source of ['python-worker-sdk', 'python-demo']) {
    const report = readReport(source, paths[source]);
    if (!report) continue;
    const totals = report.totals ?? {};
    const linesTotal = totals.num_statements;
    const linesCovered = totals.covered_lines;
    const branchTotal = totals.num_branches;
    const branchCovered = totals.covered_branches;
    const linePercent = totals.percent_covered;
    const branchPercent =
      typeof branchTotal === 'number' && branchTotal === 0
        ? 100
        : typeof branchTotal === 'number' && typeof branchCovered === 'number'
          ? (branchCovered / branchTotal) * 100
          : undefined;
    sources.push({
      source,
      language: 'python',
      lines: metric(source, 'lines', linesTotal, linesCovered, linePercent),
      branches: metric(
        source,
        'branches',
        branchTotal,
        branchCovered,
        branchPercent,
      ),
    });
  }

  sources.sort((left, right) => left.source.localeCompare(right.source));
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    thresholdEnforcement: false,
    sources,
    validation: { errors },
  };
  const outputPath = resolve(output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);

  const lines = [
    '## Coverage evidence',
    '',
    'Percentage thresholds are not yet enforced; this report establishes the corrected baseline.',
    '',
    '| Source | Lines | Branches | Functions | Statements |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...sources.map(
      (source) =>
        `| ${source.source} | ${source.lines.percent}% | ${source.branches.percent}% | ${source.functions ? `${source.functions.percent}%` : 'n/a'} | ${source.statements ? `${source.statements.percent}%` : 'n/a'} |`,
    ),
  ];
  if (errors.length > 0) {
    lines.push('', ...errors.map((error) => `- ${error}`));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  if (errors.length > 0) process.exitCode = 1;
}
