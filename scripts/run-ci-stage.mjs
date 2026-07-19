import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const usage =
  'Usage: node scripts/run-ci-stage.mjs --stage <name> --output <path> -- <command> [arguments...]';

const separatorIndex = process.argv.indexOf('--', 2);
if (separatorIndex === -1) {
  console.error(usage);
  process.exitCode = 2;
} else {
  const wrapperArguments = process.argv.slice(2, separatorIndex);
  const command = process.argv.slice(separatorIndex + 1);
  const readOption = (name) => {
    const index = wrapperArguments.indexOf(name);
    return index === -1 ? undefined : wrapperArguments[index + 1];
  };

  const stage = readOption('--stage');
  const output = readOption('--output');

  if (!stage || !output || command.length === 0) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    const startedAt = new Date();
    const startedAtMilliseconds = performance.now();
    const result = spawnSync(command[0], command.slice(1), {
      env: process.env,
      stdio: 'inherit',
    });
    const completedAt = new Date();
    const durationMilliseconds = Math.max(
      0,
      performance.now() - startedAtMilliseconds,
    );
    const exitCode =
      typeof result.status === 'number'
        ? result.status
        : result.error || result.signal
          ? 1
          : 0;
    const metric = {
      schemaVersion: 1,
      stage,
      command,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMilliseconds: Number(durationMilliseconds.toFixed(3)),
      durationSeconds: Number((durationMilliseconds / 1000).toFixed(3)),
      success: exitCode === 0,
      exitCode,
      signal: result.signal ?? null,
      spawnError: result.error?.message ?? null,
      github: {
        runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        job: process.env.GITHUB_JOB ?? null,
        eventName: process.env.GITHUB_EVENT_NAME ?? null,
        ref: process.env.GITHUB_REF ?? null,
        sha: process.env.GITHUB_SHA ?? null,
      },
    };

    try {
      const outputPath = resolve(output);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(metric, null, 2)}\n`);
    } catch (error) {
      console.error(
        `Failed to write CI stage metric to ${output}: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }

    if (result.error) {
      console.error(`Failed to execute CI stage ${stage}: ${result.error.message}`);
    }

    if (process.exitCode !== 1) {
      process.exitCode = exitCode;
    }
  }
}
