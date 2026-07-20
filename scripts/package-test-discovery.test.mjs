import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignoredDirectories = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'generated',
]);

function packageScript(packagePath) {
  const packageJson = JSON.parse(
    readFileSync(join(root, packagePath, 'package.json'), 'utf8'),
  );
  return packageJson.scripts?.test;
}

function discoverTests(packagePath) {
  const tests = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) visit(join(directory, entry.name));
        continue;
      }
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
        tests.push(relative(root, join(directory, entry.name)).replaceAll('\\', '/'));
      }
    }
  };
  visit(join(root, packagePath));
  return tests.sort();
}

describe('package-local test discovery', () => {
  it('uses package-root filters instead of narrow test-file paths', () => {
    expect(packageScript('apps/control-plane')).toBe(
      'vitest run --root ../.. apps/control-plane',
    );
    expect(packageScript('apps/cli')).toBe('vitest run --root ../.. apps/cli');
  });

  it('retains regression fixtures outside the previously narrow filters', () => {
    const controlPlaneTests = discoverTests('apps/control-plane');
    const cliTests = discoverTests('apps/cli');

    expect(controlPlaneTests.length).toBeGreaterThan(1);
    expect(controlPlaneTests).toEqual(
      expect.arrayContaining([
        expect.not.stringMatching(/apps\/control-plane\/test\/health\.test\.ts$/),
      ]),
    );
    expect(cliTests).toEqual(
      expect.arrayContaining([expect.stringMatching(/^apps\/cli\/src\//)]),
    );
  });
});
