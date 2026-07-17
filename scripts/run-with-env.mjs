import { spawn } from 'node:child_process';
import process from 'node:process';

try {
  process.loadEnvFile('.env');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  globalThis.console.error(
    'Usage: node scripts/run-with-env.mjs <command> [args...]',
  );
  process.exit(2);
}

const authPreload = new URL(
  './fetch-control-plane-auth.mjs',
  import.meta.url,
).href;
const inheritedNodeOptions = process.env.NODE_OPTIONS ?? '';
const nodeOptions = inheritedNodeOptions.includes(authPreload)
  ? inheritedNodeOptions
  : [inheritedNodeOptions, `--import=${authPreload}`].filter(Boolean).join(' ');
const useProcessGroup = process.platform !== 'win32';
const child = spawn(command, args, {
  stdio: 'inherit',
  shell: false,
  detached: useProcessGroup,
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});
let forceTimer;

function signalChild(signal) {
  if (child.pid === undefined) return;
  if (useProcessGroup) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    return;
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

child.on('error', (error) => {
  globalThis.console.error(error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (forceTimer) globalThis.clearTimeout(forceTimer);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    signalChild(signal);
    forceTimer = globalThis.setTimeout(() => signalChild('SIGKILL'), 3_000);
    forceTimer.unref();
  });
}
