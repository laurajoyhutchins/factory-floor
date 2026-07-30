import { spawn } from 'node:child_process';
import console from 'node:console';
import { once } from 'node:events';
import {
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const evidenceDirectory = join(root, '.factory-floor/browser-smoke');
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const operatorToken =
  process.env.CONTROL_PLANE_OPERATOR_TOKEN ??
  'factory_floor_browser_smoke_operator_token';
const artifactRoot = join(evidenceDirectory, 'artifacts');
const children = new Set();
let cleanupPromise;
let interruptedSignal;
let databaseReady = false;

function attachLogs(child, name) {
  const stream = createWriteStream(join(evidenceDirectory, `${name}.log`), {
    flags: 'a',
  });
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
    stream.write(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
    stream.write(chunk);
  });
  child.once('close', () => stream.end());
}

function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    detached: process.platform !== 'win32',
    env: { ...process.env, ...options.env },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  if (options.capture) attachLogs(child, options.capture);
  return child;
}

function signalProcessTree(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      return;
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessTree(child, 'SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    signalProcessTree(child, 'SIGKILL');
    await once(child, 'exit').catch(() => undefined);
  }
}

function cleanupChildren() {
  cleanupPromise ??= Promise.allSettled([...children].reverse().map(stopChild));
  return cleanupPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interruptedSignal = signal;
    void cleanupChildren();
  });
}

async function waitForExit(child, label) {
  const [code, signal] = await once(child, 'exit');
  if (interruptedSignal) {
    throw new Error(`${label} interrupted by ${interruptedSignal}`);
  }
  if (code !== 0 || signal !== null) {
    throw new Error(`${label} failed with code ${code} signal ${signal}`);
  }
}

async function run(command, args, label, env = {}) {
  console.log(`[browser-smoke] ${label}`);
  await waitForExit(spawnTracked(command, args, { env }), label);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('unable to allocate an isolated browser-smoke port');
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function waitForHttp(url, headers = {}) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(url, { headers });
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) =>
      globalThis.setTimeout(resolveDelay, 200),
    );
  }
  throw lastError ?? new Error(`${url} did not become ready`);
}

function allFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? allFiles(path) : [path];
  });
}

function assertNoPrivilegedCredentialsInBundle() {
  const bundle = allFiles(join(root, 'apps/console/dist'))
    .filter((path) => /\.(?:js|css|html|map)$/.test(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  const privileged = {
    CONTROL_PLANE_ADMIN_TOKEN: process.env.CONTROL_PLANE_ADMIN_TOKEN,
    WORKER_API_BEARER_TOKEN: process.env.WORKER_API_BEARER_TOKEN,
    DATABASE_URL: databaseUrl,
  };
  for (const [name, value] of Object.entries(privileged)) {
    if (value && bundle.includes(value)) {
      throw new Error(
        `privileged credential leaked into browser bundle: ${name}`,
      );
    }
  }
}

async function latestRunCandidates(demoOutput) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      'select * from commands order by created_at desc limit 5',
    );
    const candidates = result.rows.flatMap((row) => [
      row.id,
      row.command_id,
      row.correlation_id,
    ]);
    for (const match of demoOutput.matchAll(
      /"(?:commandId|correlationId)"\s*:\s*"([^"]+)"/g,
    )) {
      candidates.push(match[1]);
    }
    return [
      ...new Set(candidates.filter((value) => typeof value === 'string')),
    ];
  } finally {
    await client.end();
  }
}

async function selectRunId(controlPlaneUrl, candidates) {
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${operatorToken}`,
    'x-factory-floor-principal-id': 'operator:browser-smoke',
    'x-factory-floor-adapter': 'playwright-browser-smoke',
  };
  for (const candidate of candidates) {
    const response = await globalThis.fetch(
      `${controlPlaneUrl}/api/v1/operator/runs/${encodeURIComponent(candidate)}`,
      { headers },
    );
    if (response.ok) return candidate;
    if (response.status !== 404) {
      throw new Error(
        `run probe ${candidate} returned unexpected HTTP ${response.status}`,
      );
    }
  }
  throw new Error('unable to identify the seeded durable run');
}

await rm(evidenceDirectory, { recursive: true, force: true });
await mkdir(evidenceDirectory, { recursive: true });
await mkdir(join(root, '.factory-floor/test-results'), { recursive: true });

const demoPort = await availablePort();
const controlPlanePort = await availablePort();
const consolePort = await availablePort();
const controlPlaneUrl = `http://127.0.0.1:${controlPlanePort}`;
const consoleUrl = `http://127.0.0.1:${consolePort}`;
let demoOutput = '';
let failure;

try {
  await run('pnpm', ['services:up'], 'start browser-smoke services');
  await run('pnpm', ['services:wait'], 'wait for browser-smoke services');
  await run('pnpm', ['db:migrate'], 'migrate browser-smoke database');
  databaseReady = true;
  await run('pnpm', ['db:reset'], 'reset browser-smoke database');

  const demo = spawnTracked('pnpm', ['demo:investigation'], {
    env: {
      DATABASE_URL: databaseUrl,
      FACTORY_FLOOR_DEMO_PORT: String(demoPort),
      ARTIFACT_STORE_ROOT: artifactRoot,
    },
    capture: 'investigation-demo',
  });
  demo.stdout?.on('data', (chunk) => {
    demoOutput += String(chunk);
  });
  await waitForExit(demo, 'investigation demo');

  await run('pnpm', ['build:console'], 'build production console', {
    VITE_FACTORY_FLOOR_OPERATOR_TOKEN: operatorToken,
    VITE_FACTORY_FLOOR_CONTROL_PLANE_URL: '',
  });
  assertNoPrivilegedCredentialsInBundle();

  const controlPlane = spawnTracked(
    process.execPath,
    ['--import', 'tsx', 'apps/control-plane/src/server.ts'],
    {
      env: {
        HOST: '127.0.0.1',
        PORT: String(controlPlanePort),
        DATABASE_URL: databaseUrl,
        FACTORY_FLOOR_CONTROL_PLANE_URL: controlPlaneUrl,
        CONTROL_PLANE_OPERATOR_TOKEN: operatorToken,
        ARTIFACT_STORE_ROOT: artifactRoot,
      },
      capture: 'control-plane',
    },
  );
  await waitForHttp(`${controlPlaneUrl}/health`);

  const runId = await selectRunId(
    controlPlaneUrl,
    await latestRunCandidates(demoOutput),
  );

  const preview = spawnTracked(
    'pnpm',
    [
      '--filter',
      '@factory-floor/console',
      'exec',
      'vite',
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(consolePort),
      '--strictPort',
    ],
    {
      env: {
        FACTORY_FLOOR_CONSOLE_CONTROL_PLANE_URL: controlPlaneUrl,
      },
      capture: 'console-preview',
    },
  );
  void preview;
  await waitForHttp(consoleUrl);

  await writeFile(
    join(evidenceDirectory, 'fixture.json'),
    `${JSON.stringify(
      {
        runId,
        baseUrl: consoleUrl,
        controlPlaneUrl,
        viewports: ['chromium-desktop', 'chromium-mobile'],
      },
      null,
      2,
    )}\n`,
  );

  await run(
    'pnpm',
    ['exec', 'playwright', 'test', '--config', 'playwright.config.ts'],
    'run Playwright operator smoke',
    { FACTORY_FLOOR_BROWSER_BASE_URL: consoleUrl },
  );
} catch (error) {
  failure = error;
} finally {
  await cleanupChildren();
  if (databaseReady) {
    try {
      await run('pnpm', ['db:reset'], 'reset browser-smoke database state');
    } catch (error) {
      console.error(error);
      failure ??= error;
    }
  }
  try {
    await run('pnpm', ['services:clean'], 'stop browser-smoke services');
  } catch (error) {
    console.error(error);
    failure ??= error;
  }
}

if (interruptedSignal) {
  process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143;
} else if (failure) {
  throw failure;
}
