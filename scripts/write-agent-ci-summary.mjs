import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const usage =
  'Usage: node scripts/write-agent-ci-summary.mjs --manifest <path> --output <path> --job <name> [--artifact <name>]';

const readOption = (name) => {
  const index = process.argv.indexOf(name, 2);
  return index === -1 ? undefined : process.argv[index + 1];
};

const manifestPath = readOption('--manifest');
const outputPath = readOption('--output');
const job = readOption('--job');
const artifact = readOption('--artifact');

const normalizeLine = (line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim();

const errorPattern =
  /(?:^|\b)(?:error|fail|failed|failure|fatal|exception|assertionerror|typeerror|referenceerror|syntaxerror|not ok)(?:\b|:)/i;
const noisePattern =
  /(?:0 errors?|0 failures?|no errors?|without errors?|error count:\s*0|failures?\s*[:=]\s*0)/i;

export const findActionableError = (text) => {
  const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const match = lines.find((line) => errorPattern.test(line) && !noisePattern.test(line));
  return match ? match.slice(0, 500) : null;
};

export const buildSummary = ({ manifest, environment, jobStatus, artifactName }) => {
  const stages = manifest.stages
    .map((stage) => {
      const log = stage.logs.find((candidate) => existsSync(resolve(candidate)));
      if (!log) {
        return null;
      }
      const text = readFileSync(resolve(log), 'utf8');
      return {
        name: stage.name,
        command: stage.command,
        log,
        firstActionableError: findActionableError(text),
      };
    })
    .filter(Boolean);

  const failed = jobStatus !== 'success';
  const failedStage = failed ? stages.at(-1) ?? null : null;
  const repository = environment.GITHUB_REPOSITORY ?? null;
  const runId = environment.GITHUB_RUN_ID ?? null;
  const serverUrl = environment.GITHUB_SERVER_URL ?? 'https://github.com';

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repository,
    headSha: environment.GITHUB_SHA ?? null,
    workflow: environment.GITHUB_WORKFLOW ?? null,
    runId,
    runAttempt: environment.GITHUB_RUN_ATTEMPT ?? null,
    job: environment.GITHUB_JOB ?? job,
    result: jobStatus,
    stale: false,
    failedStage: failedStage?.name ?? null,
    firstActionableError: failedStage?.firstActionableError ?? null,
    reproductionCommand: failedStage?.command ?? null,
    stages: stages.map((stage, index) => ({
      name: stage.name,
      command: stage.command,
      log: stage.log,
      result: failed && index === stages.length - 1 ? 'failed' : 'passed',
    })),
    artifacts: artifactName ? [artifactName] : [],
    runUrl: repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null,
  };
};

const run = () => {
  if (!manifestPath || !outputPath || !job) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
    if (!Array.isArray(manifest.stages)) {
      throw new TypeError('Agent CI manifest must contain a stages array.');
    }

    const summary = buildSummary({
      manifest,
      environment: process.env,
      jobStatus: process.env.AGENT_CI_JOB_STATUS ?? 'unknown',
      artifactName: artifact,
    });

    const destination = resolve(outputPath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(summary, null, 2)}\n`);

    const lines = [
      '## Agent CI handoff',
      '',
      `- Result: **${summary.result}**`,
      `- Head: \`${summary.headSha ?? 'unknown'}\``,
      `- Job: \`${summary.job}\``,
      `- Failed stage: ${summary.failedStage ? `\`${summary.failedStage}\`` : 'none'}`,
      `- Reproduce: ${summary.reproductionCommand ? `\`${summary.reproductionCommand}\`` : 'not applicable'}`,
      `- First actionable error: ${summary.firstActionableError ?? 'none'}`,
      `- Artifact: ${summary.artifacts[0] ? `\`${summary.artifacts[0]}\`` : 'none'}`,
    ];

    process.stdout.write(`${lines.join('\n')}\n`);
  }
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run();
}
