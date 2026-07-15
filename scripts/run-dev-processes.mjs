import { spawn } from 'node:child_process';
import process from 'node:process';

const processes = [
  ['control-plane', 'pnpm', ['dev:control-plane']],
  ['demo-ts-worker', 'pnpm', ['dev:worker-demo-ts']],
  ['demo-py-worker', 'pnpm', ['dev:worker-demo-py']],
];

const children = new Map();
let shuttingDown = false;

function stopAll(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) {
    if (!child.killed) child.kill(signal);
  }
}

for (const [name, command, args] of processes) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  children.set(name, child);
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!shuttingDown) {
      globalThis.console.error(`[factory-floor dev] ${name} exited with ${signal ?? code}`);
      stopAll();
      process.exitCode = code ?? 1;
    }
    if (children.size === 0) process.exit(process.exitCode ?? 0);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stopAll(signal));
}
