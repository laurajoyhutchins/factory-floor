import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');

async function readRepositoryFile(path) {
  return readFile(join(repositoryRoot, path), 'utf8');
}

describe('Deciduous repository policy', () => {
  test('ignores local graph state while retaining policy and reviewed snapshots', async () => {
    const gitignore = await readRepositoryFile('.gitignore');

    expect(gitignore).toContain('.deciduous/*');
    expect(gitignore).toContain('!.deciduous/README.md');
    expect(gitignore).toContain('!.deciduous/exports/');
    expect(gitignore).toContain('.deciduous/exports/*');
    expect(gitignore).toContain('!.deciduous/exports/.gitkeep');
    expect(gitignore).toContain('!.deciduous/exports/*.json');
  });

  test('makes native Deciduous the ordinary optional path', async () => {
    const agents = await readRepositoryFile('AGENTS.md');

    expect(agents).toContain('## Deciduous');
    expect(agents).toContain('Use upstream Deciduous directly');
    expect(agents).toContain('deciduous add');
    expect(agents).toContain('deciduous link');
    expect(agents).toContain(
      'If Deciduous is unavailable, continue the repository task',
    );
    expect(agents).not.toContain('scripts/deciduous-pilot.sh');
  });

  test('keeps repository-specific guidance to authority, persistence, and evidence', async () => {
    const guide = await readRepositoryFile('tools/deciduous/README.md');
    const stateGuide = await readRepositoryFile('.deciduous/README.md');

    expect(guide).toContain('Deciduous 0.16.0');
    expect(guide).toContain(
      'Do not create or restore a Factory Floor wrapper around Deciduous',
    );
    expect(guide).toContain('offline-execution');
    expect(guide).toContain('2026-08-03-through-2026-08-14.md');
    expect(stateGuide).toContain('Use upstream Deciduous directly');
    expect(stateGuide).toContain('deciduous graph');
    expect(stateGuide).toContain('not in a centralized Deciduous graph');
  });

  test('removes the repository-specific command dialect', async () => {
    await expect(
      readRepositoryFile('scripts/deciduous-pilot.sh'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
