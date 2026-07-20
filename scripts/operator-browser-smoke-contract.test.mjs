import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));

const packageJson = json('package.json');
const workflow = YAML.parse(
  read('.github/workflows/repository-verification.yml'),
);

describe('production operator browser smoke', () => {
  it('uses a pinned project-level Playwright runner', () => {
    expect(packageJson.devDependencies['@playwright/test']).toBeDefined();
    expect(packageJson.scripts['test:browser:smoke']).toBe(
      'node scripts/run-operator-browser-smoke.mjs',
    );
    expect(existsSync(join(root, 'playwright.config.ts'))).toBe(true);

    const config = read('playwright.config.ts');
    expect(config).toContain("name: 'chromium-desktop'");
    expect(config).toContain("name: 'chromium-mobile'");
    expect(config).toContain(
      "outputDir: '.factory-floor/browser-smoke/test-results'",
    );
    expect(config).toContain("trace: 'retain-on-failure'");
    expect(config).toContain("screenshot: 'only-on-failure'");
  });

  it('runs against real seeded Factory Floor processes with isolated ports', () => {
    const runner = read('scripts/run-operator-browser-smoke.mjs');
    expect(runner).toContain("spawn('pnpm', ['demo:investigation']");
    expect(runner).toContain("spawn(process.execPath, ['--import', 'tsx'");
    expect(runner).toContain("'vite', 'preview'");
    expect(runner).toContain('server.listen(0');
    expect(runner).toContain('pnpm db:reset');
    expect(runner).toContain('finally');
    expect(runner).toContain('SIGTERM');
    expect(runner).toContain('CONTROL_PLANE_ADMIN_TOKEN');
    expect(runner).toContain('WORKER_API_BEARER_TOKEN');
    expect(runner).toContain('databaseUrl');
    expect(runner).toContain(
      'privileged credential leaked into browser bundle',
    );
  });

  it('covers routing, auth, finite events, SSE continuation, and responsive views', () => {
    const spec = read('tests/browser/operator-console.smoke.spec.ts');
    expect(spec).toContain("test.describe('production operator console'");
    expect(spec).toContain("getByRole('heading', { name: 'Run status' })");
    expect(spec).toContain("getByRole('heading', { name: 'Run topology' })");
    expect(spec).toContain(
      "getByRole('heading', { name: 'Bounded durable trace' })",
    );
    expect(spec).toContain("getByRole('heading', { name: 'Run artifacts' })");
    expect(spec).toContain('status: 401');
    expect(spec).toContain("searchParams.has('cursor')");
    expect(spec).toContain('toHaveCount(1)');
    expect(spec).toContain('keyboard.press');
    expect(spec).toContain("page.goto(`/runs/${fixture.runId}`)");
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
