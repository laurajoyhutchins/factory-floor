import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const separator = process.argv.indexOf('--');
if (separator < 3 || separator === process.argv.length - 1) {
  globalThis.console.error(
    'Usage: node scripts/run-package-entrypoint.mjs <development command...> -- <production command...>',
  );
  process.exit(2);
}

const development = process.argv.slice(2, separator);
const production = process.argv.slice(separator + 1);
const selected =
  process.env.FACTORY_FLOOR_HEADLESS_PRODUCTION === '1'
    ? production
    : development;
const [command, ...args] = selected;
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const configuredArtifactStoreRoot = process.env.ARTIFACT_STORE_ROOT?.trim();
const childEnv = {
  ...process.env,
  ...(configuredArtifactStoreRoot
    ? {
        ARTIFACT_STORE_ROOT: isAbsolute(configuredArtifactStoreRoot)
          ? configuredArtifactStoreRoot
          : resolve(repositoryRoot, configuredArtifactStoreRoot),
      }
    : {}),
};
const child = spawn(command, args, {
  stdio: 'inherit',
  env: childEnv,
  shell: false,
});
let forwardedSignal;

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    forwardedSignal = signal;
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
  });

child.on('error', (error) => {
  globalThis.console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    if (signal === forwardedSignal) {
      process.exitCode = 0;
      return;
    }
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
