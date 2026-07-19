import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');

async function readRepositoryFile(path) {
  return readFile(join(repositoryRoot, path), 'utf8');
}

describe('Deciduous pilot repository policy', () => {
  test('ignores local graph state while permitting reviewable JSON patches', async () => {
    const gitignore = await readRepositoryFile('.gitignore');

    expect(gitignore).toContain('.deciduous/*');
    expect(gitignore).toContain('!.deciduous/patches/');
    expect(gitignore).toContain('.deciduous/patches/*');
    expect(gitignore).toContain('!.deciduous/patches/.gitkeep');
    expect(gitignore).toContain('!.deciduous/patches/*.json');
  });

  test('keeps the pilot nonblocking and subordinate to existing authorities', async () => {
    const agents = await readRepositoryFile('AGENTS.md');

    expect(agents).toContain('## Deciduous pilot');
    expect(agents).toContain('Do not block edits or commits');
    expect(agents).toContain('GitHub issues, ADRs, pull requests, and commits remain authoritative');
    expect(agents).toContain('bash scripts/deciduous-pilot.sh start');
    expect(agents).toContain('bash scripts/deciduous-pilot.sh finish');
  });

  test('documents installation, workflow, security, evaluation, and rollback', async () => {
    const guide = await readRepositoryFile('tools/deciduous/README.md');

    expect(guide).toContain('Deciduous 0.16.0');
    expect(guide).toContain('Three-checkpoint workflow');
    expect(guide).toContain('Never record secrets');
    expect(guide).toContain('10 substantial pull requests or 30 days');
    expect(guide).toContain('## Rollback');
  });

  test('never invokes generated assistant integration', async () => {
    const wrapper = await readRepositoryFile('scripts/deciduous-pilot.sh');

    expect(wrapper).not.toContain('deciduous init');
    expect(wrapper).not.toContain('.claude');
    expect(wrapper).not.toContain('.opencode');
    expect(wrapper).not.toContain('.windsurf');
  });
});
