import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

function read(path) {
  return readFileSync(`${root}/${path}`, 'utf8');
}

describe('coverage evidence contract', () => {
  it('collects coverage inside canonical CI test executions', () => {
    const packageJson = JSON.parse(read('package.json'));

    expect(packageJson.devDependencies['@vitest/coverage-v8']).toBe('^3.2.4');
    expect(packageJson.scripts['test:ci']).toContain('--coverage');
    expect(packageJson.scripts['test:python:ci']).toContain(
      '--cov=factory_floor_worker_sdk',
    );
    expect(packageJson.scripts['test:python:ci']).toContain(
      '--cov=factory_floor_demo_py',
    );
    expect(packageJson.scripts['test:python:ci']).toContain('--cov-branch');
  });

  it('keeps exclusions explicit and thresholds disabled', () => {
    const config = read('vitest.config.ts');
    const qualityGates = JSON.parse(read('quality-gates.json'));

    expect(config).toContain("provider: 'v8'");
    expect(config).toContain("reportsDirectory: '.factory-floor/coverage/typescript'");
    expect(config).toContain("'**/generated/**'");
    expect(config).toContain("'apps/control-plane/src/server.ts'");
    expect(config).not.toContain('thresholds:');
    expect(qualityGates.futureCoverageRatchet.enforced).toBe(false);
  });

  it('retains reports and fails when the summary cannot be produced', () => {
    const workflow = read('.github/workflows/repository-verification.yml');

    expect(workflow).toContain('id: coverage-summary');
    expect(workflow).toContain('pnpm coverage:summarize');
    expect(workflow).toContain('.factory-floor/coverage/');
    expect(workflow).toContain('coverage-summary.log');
    expect(workflow).toContain("steps.coverage-summary.outcome == 'failure'");
  });
});
