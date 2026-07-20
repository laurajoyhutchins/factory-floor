import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import rootVitestConfig from '../vitest.config.ts';

const root = new URL('../', import.meta.url);
const read = (relativePath) =>
  readFileSync(new URL(relativePath, root), 'utf8');

describe('repository verification wiring', () => {
  it('discovers unit tests and preserves browser test projects', () => {
    const projects = rootVitestConfig.test.projects;
    const rootProject = projects.find(
      (project) => typeof project === 'object' && project !== null,
    );

    expect(projects).toEqual(
      expect.arrayContaining([
        'apps/console/vitest.config.ts',
        'packages/operator-ui-react/vitest.config.ts',
      ]),
    );
    expect(rootProject.test.include).toEqual(
      expect.arrayContaining([
        'apps/**/*.test.ts',
        'apps/**/*.test.tsx',
        'packages/**/*.test.ts',
        'packages/**/*.test.tsx',
        'workers/**/*.test.ts',
        'workers/**/*.test.tsx',
        'scripts/**/*.test.mjs',
      ]),
    );
    expect(rootProject.test.include).not.toEqual(
      expect.arrayContaining([
        'tests/**/*.test.ts',
        'tests/integration/**/*.test.ts',
        'tests/acceptance/**/*.test.ts',
      ]),
    );
    expect(rootProject.test.exclude).toEqual(
      expect.arrayContaining([
        'tests/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/generated/**',
        'apps/console/**',
        'packages/operator-ui-react/**',
      ]),
    );
    const consoleVitestConfig = read('apps/console/vitest.config.ts');
    expect(consoleVitestConfig).toContain("environment: 'jsdom'");
    expect(consoleVitestConfig).toContain(
      "setupFiles: ['./src/test/setup.ts']",
    );
    const operatorUiVitestConfig = read(
      'packages/operator-ui-react/vitest.config.ts',
    );
    expect(operatorUiVitestConfig).toContain("environment: 'jsdom'");
    expect(operatorUiVitestConfig).toContain(
      "setupFiles: ['./src/test/setup.ts']",
    );
    expect(
      existsSync(
        new URL(
          '../packages/operator-ui-react/src/pages/pages.test.tsx',
          import.meta.url,
        ),
      ),
    ).toBe(true);
  });

  it('maps package verification commands to explicit canonical stages', () => {
    const packageJson = JSON.parse(read('package.json'));
    const verificationScript = read('scripts/verify.sh');

    expect(packageJson.scripts).toMatchObject({
      'ci:quality:check': 'node scripts/check-ci-quality-gates.mjs',
      'verify:static': 'bash scripts/verify.sh static',
      'verify:unit': 'bash scripts/verify.sh unit',
      'verify:fast': 'bash scripts/verify.sh fast',
      'verify:services': 'bash scripts/verify.sh services',
      'verify:integration': 'bash scripts/verify.sh integration',
      'verify:acceptance': 'bash scripts/verify.sh acceptance',
      verify: 'bash scripts/verify.sh all',
    });
    for (const stage of [
      'static',
      'unit',
      'fast',
      'services',
      'integration',
      'acceptance',
    ]) {
      expect(verificationScript).toContain(`verify_${stage}()`);
    }
    expect(verificationScript).toContain('pnpm ci:quality:check');
    expect(verificationScript).toContain(
      'pnpm --filter @factory-floor/console build',
    );
  });

  it('keeps verification stages reproducible from caller environments', () => {
    const verificationScript = read('scripts/verify.sh');
    const acceptanceScript = read('scripts/accept-m1.sh');
    const integrationConfig = read('vitest.integration.config.ts');
    const unitStage = verificationScript.slice(
      verificationScript.indexOf('verify_unit() {'),
      verificationScript.indexOf('verify_fast() {'),
    );
    const integrationStage = verificationScript.slice(
      verificationScript.indexOf('verify_integration() {'),
      verificationScript.indexOf('verify_acceptance() {'),
    );

    expect(unitStage).toContain('unset DATABASE_URL TEST_DATABASE_URL');
    expect(
      unitStage.indexOf('unset DATABASE_URL TEST_DATABASE_URL'),
    ).toBeLessThan(unitStage.indexOf('pnpm test'));
    expect(unitStage).toContain('pnpm test:ci');
    expect(unitStage).toContain('pnpm test:python:ci');
    expect(integrationStage.indexOf('pnpm typecheck')).toBeGreaterThan(-1);
    expect(integrationStage.indexOf('pnpm typecheck')).toBeLessThan(
      integrationStage.indexOf('pnpm test:integration'),
    );
    expect(verificationScript).toContain('pnpm db:reset');
    expect(verificationScript).not.toContain(
      'pnpm --filter @factory-floor/db migrate reset',
    );
    expect(integrationConfig).toContain("'@factory-floor/artifact-store'");
    expect(integrationConfig).toContain("'@factory-floor/db'");
    expect(integrationConfig).toContain("'@factory-floor/runtime-core'");
    expect(acceptanceScript).toContain('pnpm verify:static');
    expect(acceptanceScript).toContain('pnpm verify:unit');
    expect(acceptanceScript).toContain('pnpm verify:services');
    expect(acceptanceScript).toContain('pnpm verify:integration');
    expect(acceptanceScript).not.toContain('pnpm test:integration');
    expect(acceptanceScript).not.toContain('pnpm exec prettier --check');
  });

  it('makes CI call measured canonical stages with immutable actions', () => {
    const workflow = parse(
      read('.github/workflows/repository-verification.yml'),
    );
    const jobs = Object.values(workflow.jobs);
    const steps = jobs.flatMap((job) => job.steps ?? []);
    const runCommands = steps.map((step) => step.run ?? '').join('\n');
    const actionReferences = steps
      .map((step) => step.uses)
      .filter((reference) => typeof reference === 'string');

    expect(runCommands).toContain('pnpm verify:static');
    expect(runCommands).toContain('pnpm verify:unit');
    expect(runCommands).toContain('pnpm verify:services');
    expect(runCommands).toContain('pnpm verify:integration');
    expect(runCommands).toContain('pnpm verify:acceptance');
    expect(runCommands).toContain('pnpm test:browser:smoke');
    expect(runCommands).not.toMatch(
      /pnpm (lint|typecheck|test(?!:browser:smoke)|test:python|format:check)\b/,
    );
    expect(runCommands).not.toContain('@factory-floor/console test');
    for (const stage of [
      'static',
      'unit',
      'services',
      'integration',
      'acceptance',
      'm1-clean-acceptance',
    ]) {
      expect(runCommands).toContain(
        `node scripts/run-ci-stage.mjs --stage ${stage}`,
      );
    }
    expect(runCommands).toContain('node scripts/summarize-ci-metrics.mjs');
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
    for (const job of jobs) {
      const artifactPaths = (job.steps ?? [])
        .filter((step) => step.uses?.startsWith('actions/upload-artifact@'))
        .map((step) => step.with?.path ?? '')
        .join('\n');
      expect(artifactPaths).toContain('.factory-floor/ci-metrics/');
    }
    expect(workflow.jobs['m1-acceptance'].needs).toBe('service-verification');
  });

  it('keeps console typechecking, tests, and production build in permanent verification', () => {
    const consolePackage = JSON.parse(read('apps/console/package.json'));
    const verificationScript = read('scripts/verify.sh');

    expect(consolePackage.scripts).toMatchObject({
      typecheck: 'tsc -p tsconfig.json --pretty false',
      test: 'vitest run --config vitest.config.ts',
    });
    expect(consolePackage.scripts.build).toContain('vite build');
    expect(verificationScript).toContain('pnpm typecheck');
    expect(verificationScript).toContain('pnpm test');
    expect(verificationScript).toContain(
      'pnpm --filter @factory-floor/console build',
    );
    expect(verificationScript).not.toContain('@factory-floor/console test');
    expect(read('tsconfig.json')).toContain('"path": "apps/console"');
    expect(read('tsconfig.json')).toContain(
      '"path": "packages/operator-client-ts"',
    );
    expect(read('tsconfig.json')).toContain(
      '"path": "packages/operator-ui-react"',
    );
  });

  it('contains no references to the obsolete workflow filename', () => {
    const result = spawnSync(
      'git',
      ['grep', '-n', ['task1', 'verification.yml'].join('-'), '--', '.'],
      { cwd: new URL('../', import.meta.url), encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
  });
});
