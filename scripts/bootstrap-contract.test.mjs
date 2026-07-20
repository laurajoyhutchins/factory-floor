import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignoredDirectories = new Set([
  '.git',
  '.venv',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'generated',
]);

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function discoverPythonProjects() {
  const projects = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
      const child = join(directory, entry.name);
      if (existsSync(join(child, 'pyproject.toml'))) {
        projects.push(relative(root, child).replaceAll('\\', '/'));
      }
      visit(child);
    }
  };
  visit(root);
  return projects.sort();
}

describe('canonical workspace bootstrap', () => {
  it('discovers every locked Python project instead of maintaining partial paths', () => {
    const projects = discoverPythonProjects();
    expect(projects).toEqual(
      expect.arrayContaining([
        'packages/contracts-py',
        'packages/worker-sdk-py',
        'workers/demo-py',
      ]),
    );
    for (const project of projects) {
      expect(existsSync(join(root, project, 'uv.lock')), project).toBe(true);
    }

    const bootstrap = read('scripts/bootstrap-workspace.sh');
    expect(bootstrap).toContain('find "$ROOT_DIR"');
    expect(bootstrap).toContain('-name pyproject.toml');
    expect(bootstrap).toContain('uv sync --project "$project" --locked');
    expect(bootstrap).not.toContain(
      'for project in "$ROOT_DIR" "$ROOT_DIR/packages/worker-sdk-py"',
    );
  });

  it('makes bootstrap the only dependency installation path in CI', () => {
    const workflow = read('.github/workflows/repository-verification.yml');
    for (const duplicatedSetup of [
      'name: Activate pnpm',
      'name: Install uv',
      'name: Install locked dependencies',
      'pnpm install --frozen-lockfile',
      'uv sync --project',
    ]) {
      expect(workflow).not.toContain(duplicatedSetup);
    }

    expect(
      workflow.match(
        /^\s+bash scripts\/bootstrap-workspace\.sh 2>&1 \| tee bootstrap\.log$/gm,
      ),
    ).toHaveLength(2);
    expect(workflow).toContain('bash scripts/accept-m1.sh');
  });
});
