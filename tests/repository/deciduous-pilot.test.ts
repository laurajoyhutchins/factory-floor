import { afterEach, describe, expect, test } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const wrapper = join(repositoryRoot, 'scripts/deciduous-pilot.sh');
const temporaryDirectories: string[] = [];

async function makeFakeDeciduous(version = 'deciduous 0.16.0') {
  const directory = await mkdtemp(join(tmpdir(), 'factory-floor-deciduous-'));
  temporaryDirectories.push(directory);
  const log = join(directory, 'calls.log');
  const executable = join(directory, 'deciduous');
  await writeFile(
    executable,
    `#!/usr/bin/env bash\nset -euo pipefail\nif [[ "${1:-}" == "--version" ]]; then\n  printf '%s\\n' ${JSON.stringify(version)}\n  exit 0\nfi\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`,
  );
  await chmod(executable, 0o755);
  return { directory, log };
}

function runWrapper(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [wrapper, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Deciduous pilot wrapper', () => {
  test('doctor reports an actionable error when deciduous is absent', () => {
    const result = runWrapper(['doctor'], { PATH: '/usr/bin:/bin' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Deciduous is not installed');
    expect(result.stderr).toContain('0.16.0');
  });

  test('doctor accepts the reviewed version', async () => {
    const fake = await makeFakeDeciduous();
    const result = runWrapper(['doctor'], { PATH: `${fake.directory}:/usr/bin:/bin` });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Deciduous 0.16.0 is ready');
  });

  test('doctor rejects a different installed version without upgrading it', async () => {
    const fake = await makeFakeDeciduous('deciduous 0.17.0');
    const result = runWrapper(['doctor'], { PATH: `${fake.directory}:/usr/bin:/bin` });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected 0.16.0');
    expect(result.stderr).toContain('found 0.17.0');
  });

  test.each([
    ['start', []],
    ['decision', []],
    ['observe', []],
    ['finish', []],
    ['export', []],
  ])('%s rejects missing required arguments', async (command, args) => {
    const fake = await makeFakeDeciduous();
    const result = runWrapper([command, ...args], { PATH: `${fake.directory}:/usr/bin:/bin` });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });

  test('maps the three workflow checkpoints to deciduous commands', async () => {
    const fake = await makeFakeDeciduous();

    expect(runWrapper(['init'], { PATH: `${fake.directory}:/usr/bin:/bin` }).status).toBe(0);
    expect(runWrapper(['recover'], { PATH: `${fake.directory}:/usr/bin:/bin` }).status).toBe(0);
    expect(runWrapper(['start', 'Implement issue #57'], { PATH: `${fake.directory}:/usr/bin:/bin` }).status).toBe(0);
    expect(runWrapper(['decision', 'Use a nonblocking wrapper', 'Avoid hook interference'], { PATH: `${fake.directory}:/usr/bin:/bin` }).status).toBe(0);
    expect(runWrapper(['observe', 'CI must remain offline'], { PATH: `${fake.directory}:/usr/bin:/bin` }).status).toBe(0);
    expect(runWrapper(['finish', 'Pilot wrapper implemented', 'HEAD'], { PATH: `${fake.directory}:/usr/bin:/bin` }).status).toBe(0);

    const calls = (await readFile(fake.log, 'utf8')).trim().split('\n');
    expect(calls).toEqual([
      'init --opencode',
      'nodes',
      'edges',
      'commands',
      'add goal Implement issue #57 -c 90',
      'add decision Use a nonblocking wrapper -c 85 -p Avoid hook interference',
      'add observation CI must remain offline -c 90',
      'add outcome Pilot wrapper implemented -c 95 --commit HEAD',
    ]);
  });

  test('exports a branch patch only inside the committed patch directory', async () => {
    const fake = await makeFakeDeciduous();
    await mkdir(join(repositoryRoot, '.deciduous/patches'), { recursive: true });

    const valid = runWrapper(['export', 'agent-deciduous-pilot.json', 'agent/deciduous-pilot'], {
      PATH: `${fake.directory}:/usr/bin:/bin`,
    });
    const invalid = runWrapper(['export', '../escape.json', 'agent/deciduous-pilot'], {
      PATH: `${fake.directory}:/usr/bin:/bin`,
    });

    expect(valid.status).toBe(0);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain('simple .json filename');
    expect((await readFile(fake.log, 'utf8')).trim()).toBe(
      'diff export --branch agent/deciduous-pilot -o .deciduous/patches/agent-deciduous-pilot.json',
    );
  });
});
