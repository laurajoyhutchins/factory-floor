import { afterEach, describe, expect, test } from 'vitest';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const wrapper = join(repositoryRoot, 'scripts/deciduous-pilot.sh');
const temporaryDirectories = [];

async function makeHarness(version = 'deciduous 0.16.0') {
  const directory = await mkdtemp(join(tmpdir(), 'factory-floor-deciduous-'));
  temporaryDirectories.push(directory);

  const log = join(directory, 'calls.log');
  const counter = join(directory, 'counter');
  const stateDirectory = join(directory, 'state');
  const executable = join(directory, 'deciduous');
  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `log=${JSON.stringify(log)}`,
    `counter=${JSON.stringify(counter)}`,
    'if [[ "${1:-}" == "--version" ]]; then',
    `  printf '%s\\n' ${JSON.stringify(version)}`,
    '  exit 0',
    'fi',
    'printf "%s" "${1:-}" >> "$log"',
    'shift || true',
    'for argument in "$@"; do',
    '  printf "\\t%s" "$argument" >> "$log"',
    'done',
    'printf "\\n" >> "$log"',
    'command_name="$(tail -n 1 "$log" | cut -f1)"',
    'if [[ "$command_name" == "add" ]]; then',
    '  current=0',
    '  if [[ -f "$counter" ]]; then current="$(cat "$counter")"; fi',
    '  current=$((current + 1))',
    '  printf "%s\\n" "$current" > "$counter"',
    '  printf "Created node %s\\n" "$current"',
    'fi',
    'if [[ "$command_name" == "graph" ]]; then',
    '  printf \'{"nodes":[],"edges":[]}\\n\'',
    'fi',
    '',
  ].join('\n');

  await writeFile(executable, script);
  await chmod(executable, 0o755);

  return { directory, log, stateDirectory };
}

function runWrapper(args, harness, environment = {}) {
  const path = harness ? `${harness.directory}:/usr/bin:/bin` : '/usr/bin:/bin';
  return spawnSync('bash', [wrapper, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: path,
      ...(harness ? { DECIDUOUS_PILOT_STATE_DIR: harness.stateDirectory } : {}),
      ...environment,
    },
  });
}

async function readCalls(harness) {
  return (await readFile(harness.log, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Deciduous pilot wrapper', () => {
  test('doctor reports an actionable error when deciduous is absent', () => {
    const result = runWrapper(['doctor']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Deciduous is not installed');
    expect(result.stderr).toContain('0.16.0');
  });

  test('doctor accepts the reviewed version', async () => {
    const harness = await makeHarness();
    const result = runWrapper(['doctor'], harness);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Deciduous 0.16.0 is ready');
  });

  test('doctor rejects a different installed version without upgrading it', async () => {
    const harness = await makeHarness('deciduous 0.17.0');
    const result = runWrapper(['doctor'], harness);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected 0.16.0');
    expect(result.stderr).toContain('found 0.17.0');
  });

  test.each(['start', 'decision', 'observe', 'finish', 'export'])(
    '%s rejects missing required arguments',
    async (command) => {
      const harness = await makeHarness();
      const result = runWrapper([command], harness);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Usage:');
    },
  );

  test('initializes only local graph state and does not install assistant integration', async () => {
    const harness = await makeHarness();
    const result = runWrapper(['init'], harness);

    expect(result.status).toBe(0);
    expect(await readCalls(harness)).toEqual([['nodes']]);
    await expect(stat(harness.stateDirectory)).resolves.toBeDefined();
  });

  test('creates and links the three workflow checkpoints into one chain', async () => {
    const harness = await makeHarness();

    expect(runWrapper(['start', 'Implement issue #57'], harness).status).toBe(
      0,
    );
    expect(
      runWrapper(
        [
          'decision',
          'Use a nonblocking wrapper',
          'Avoid generated hook interference',
        ],
        harness,
      ).status,
    ).toBe(0);
    expect(
      runWrapper(['observe', 'CI must remain offline'], harness).status,
    ).toBe(0);
    expect(
      runWrapper(['finish', 'Pilot wrapper implemented', 'HEAD'], harness)
        .status,
    ).toBe(0);

    expect(await readCalls(harness)).toEqual([
      ['add', 'goal', 'Implement issue #57', '-c', '90'],
      [
        'add',
        'decision',
        'Use a nonblocking wrapper',
        '-d',
        'Avoid generated hook interference',
        '-c',
        '85',
      ],
      [
        'link',
        '1',
        '2',
        '-r',
        'Avoid generated hook interference',
        '-t',
        'leads_to',
      ],
      [
        'add',
        'observation',
        'CI must remain offline',
        '-d',
        'CI must remain offline',
        '-c',
        '90',
      ],
      [
        'link',
        '2',
        '3',
        '-r',
        'Observation recorded during pilot',
        '-t',
        'leads_to',
      ],
      [
        'add',
        'outcome',
        'Pilot wrapper implemented',
        '-c',
        '95',
        '--commit',
        'HEAD',
      ],
      ['link', '3', '4', '-r', 'Pilot task completed', '-t', 'leads_to'],
    ]);

    await expect(
      stat(join(harness.stateDirectory, 'current-node')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('requires a started chain before adding a decision', async () => {
    const harness = await makeHarness();
    const result = runWrapper(
      ['decision', 'Use a wrapper', 'Keep the pilot repository-owned'],
      harness,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No active Deciduous pilot chain');
  });

  test('recovers graph context through read-only commands', async () => {
    const harness = await makeHarness();
    const result = runWrapper(['recover'], harness);

    expect(result.status).toBe(0);
    expect(await readCalls(harness)).toEqual([
      ['nodes'],
      ['edges'],
      ['commands'],
    ]);
  });

  test('exports a validated full-graph snapshot inside the configured export directory', async () => {
    const harness = await makeHarness();

    const valid = runWrapper(['export', 'agent-deciduous-pilot.json'], harness);
    const invalid = runWrapper(['export', '../escape.json'], harness);

    expect(valid.status).toBe(0);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain('simple .json filename');
    expect(await readCalls(harness)).toEqual([['graph']]);
    expect(
      JSON.parse(
        await readFile(
          join(
            harness.stateDirectory,
            'exports/agent-deciduous-pilot.json',
          ),
          'utf8',
        ),
      ),
    ).toEqual({ nodes: [], edges: [] });
  });
});
