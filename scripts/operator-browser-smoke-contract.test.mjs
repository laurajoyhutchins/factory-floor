import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));

const packageJson = json('package.json');
const lockfile = read('pnpm-lock.yaml');
const workflow = YAML.parse(
  read('.github/workflows/repository-verification.yml'),
);

describe('production operator browser smoke', () => {
  it('uses a pinned project-level Playwright runner', () => {
    expect(packageJson.devDependencies['@playwright/test']).toBeDefined();
    expect(lockfile).toContain("'@playwright/test':");
    expect(packageJson.scripts['test:browser:smoke']).toBe(
      'node scripts/run-operator-browser-smoke.mjs',
    );
    expect(existsSync(join(root, 'playwright.config.ts'))).toBe(true);
    expect(existsSync(join(root, 'tests/browser/tsconfig.json'))).toBe(true);

    const config = read('playwright.config.ts');
    expect(config).toContain("tsconfig: './tests/browser/tsconfig.json'");
    expect(config).toContain("name: 'chromium-desktop'");
    expect(config).toContain("name: 'chromium-mobile'");
    expect(config).toContain(
      "outputDir: '.factory-floor/browser-smoke/test-results'",
    );
    expect(config).toContain("trace: 'retain-on-failure'");
    expect(config).toContain("screenshot: 'only-on-failure'");
    expect(config).toContain("video: 'retain-on-failure'");
    expect(config).toContain('retries: 0');
  });

  it('supervises every process and cleans database and Docker state', () => {
    const runner = read('scripts/run-operator-browser-smoke.mjs');
    expect(runner).toContain("spawnTracked('pnpm', ['demo:investigation']");
    expect(runner).toContain("'apps/control-plane/src/server.ts'");
    expect(runner).toContain("'vite'");
    expect(runner).toContain("['services:up']");
    expect(runner).toContain("['services:wait']");
    expect(runner).toContain("['db:migrate']");
    expect(runner).toContain("['db:reset']");
    expect(runner).toContain("['services:clean']");
    expect(runner).toContain('cleanupChildren');
    expect(runner).toContain('interruptedSignal');
    expect(runner).toContain('SIGTERM');
    expect(runner).not.toContain('execFileSync');
    expect(runner).not.toContain('process.exit(');
  });

  it('uses isolated ports and rejects privileged browser credentials', () => {
    const runner = read('scripts/run-operator-browser-smoke.mjs');
    expect(runner).toContain("server.listen(0, '127.0.0.1'");
    expect(runner).toContain('CONTROL_PLANE_ADMIN_TOKEN');
    expect(runner).toContain('WORKER_API_BEARER_TOKEN');
    expect(runner).toContain('databaseUrl');
    expect(runner).toContain('FACTORY_FLOOR_CONTROL_PLANE_URL');
    expect(runner).toContain(
      'privileged credential leaked into browser bundle',
    );
  });

  it('proves cursor continuity, canonical states, lineage, and responsive views', () => {
    const spec = read('tests/browser/operator-console.smoke.spec.ts');
    const consoleMain = read('apps/console/src/main.tsx');
    expect(spec).toContain("new URL(batch.url).searchParams.get('cursor')");
    expect(spec).toContain('expectedIds.every');
    expect(spec).toContain('new Set(ids).size');
    expect(spec).toContain("getByText('Loading…')");
    expect(spec).toContain("getByText('disconnected')");
    expect(spec).toContain('status: 401');
    expect(spec).toContain(
      'No artifact derivations are associated with this run.',
    );
    expect(spec).toContain('The selected record was not found.');
    expect(spec).toContain('document.documentElement.scrollWidth');
    expect(spec).toContain('keyboard.press');
    expect(spec).toContain('page.goto(`/runs/${fixture.runId}`)');
    expect(consoleMain).toContain('RunDetailsPanel');
    expect(consoleMain).toContain('createRunDetailsClient');
  });

  it('makes the browser smoke required and retains actionable failure evidence', () => {
    const service = workflow.jobs['service-verification'];
    const commands = service.steps.map((step) => step.run ?? '').join('\n');
    const artifactPaths = service.steps
      .filter((step) => step.uses?.startsWith('actions/upload-artifact@'))
      .map((step) => step.with?.path ?? '')
      .join('\n');

    expect(commands).toContain(
      'pnpm exec playwright install --with-deps chromium',
    );
    expect(commands).toContain(
      'node scripts/run-ci-stage.mjs --stage browser-smoke',
    );
    expect(commands).toContain('pnpm test:browser:smoke');
    expect(artifactPaths).toContain('.factory-floor/browser-smoke/');
    expect(artifactPaths).toContain('browser-smoke.log');
  });
});
