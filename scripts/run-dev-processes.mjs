import { spawn } from 'node:child_process';
import process from 'node:process';

const processes = [
  ['control-plane', 'pnpm', ['dev:control-plane']],
  ['demo-ts-worker', 'pnpm', ['dev:worker-demo-ts']],
  ['demo-py-worker', 'pnpm', ['dev:worker-demo-py']],
];

const children = new Map();
const useProcessGroups = process.platform !== 'win32';
let shuttingDown = false;
let forceTimer;

function signalChild(child, signal) {
  if (child.pid === undefined) return;
  if (useProcessGroups) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    return;
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function stopAll(signal = 'SIGTERM') {
  if (!shuttingDown) {
    shuttingDown = true;
    for (const child of children.values()) signalChild(child, signal);
    forceTimer = globalThis.setTimeout(() => {
      for (const child of children.values()) signalChild(child, 'SIGKILL');
    }, 3_000);
    forceTimer.unref();
  }
}

for (const [name, command, args] of processes) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: useProcessGroups,
  });
  children.set(name, child);
  child.stdout?.on('data', (chunk) =>
    process.stdout.write(`[${name}] ${chunk}`),
  );
  child.stderr?.on('data', (chunk) =>
    process.stderr.write(`[${name}] ${chunk}`),
  );
  child.on('error', (error) => {
    globalThis.console.error(
      `[factory-floor dev] ${name} failed: ${error.message}`,
    );
    process.exitCode = 1;
    children.delete(name);
    stopAll();
    if (children.size === 0) process.exit(process.exitCode);
  });
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!shuttingDown) {
      globalThis.console.error(
        `[factory-floor dev] ${name} exited with ${signal ?? code}`,
      );
      process.exitCode = code ?? 1;
      stopAll();
    }
    if (children.size === 0) {
      if (forceTimer) globalThis.clearTimeout(forceTimer);
      process.exit(process.exitCode ?? 0);
    }
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    stopAll(signal);
    if (children.size === 0) process.exit(process.exitCode);
  });
}
