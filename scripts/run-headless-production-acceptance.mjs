import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const evidenceDirectory = new URL(
  '.factory-floor/verification/headless-production/',
  root,
);
const expectedArtifacts = [
  new URL('apps/control-plane/dist/server.js', root),
  new URL('workers/demo-ts/dist/index.js', root),
];

function run(command, args) {
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
}

async function assertCompiledArtifacts() {
  for (const artifact of expectedArtifacts) await access(artifact);
}

async function writeEvidence(status, fields = {}) {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    new URL('summary.json', evidenceDirectory),
    `${JSON.stringify(
      {
        status,
        mode: 'compiled-headless-production',
        browserRequired: false,
        ttyRequired: false,
        controlPlaneEntrypoint: 'apps/control-plane/dist/server.js',
        typeScriptWorkerEntrypoint: 'workers/demo-ts/dist/index.js',
        pythonWorkerEntrypoint: 'factory-floor-demo-py',
        ...fields,
      },
      null,
      2,
    )}\n`,
  );
}

run('pnpm', ['build:production']);
await assertCompiledArtifacts();
await writeEvidence('running', { startedAt: new Date().toISOString() });

const child = spawn(
  process.execPath,
  ['scripts/run-m1-live-restart-acceptance.mjs'],
  {
    cwd: rootPath,
    stdio: 'inherit',
    env: {
      ...process.env,
      FACTORY_FLOOR_HEADLESS_PRODUCTION: '1',
    },
  },
);

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => child.kill(signal));

child.on('error', async (error) => {
  globalThis.console.error(error);
  await writeEvidence('failed', { error: error.message });
  process.exitCode = 1;
});
child.on('exit', async (code, signal) => {
  const success = code === 0 && signal === null;
  await writeEvidence(success ? 'completed' : 'failed', {
    completedAt: new Date().toISOString(),
    exitCode: code,
    signal,
  });
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
