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
const ansiEscapePattern = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);
const normalizeLine = (line) => line.replace(ansiEscapePattern, '').trim();
const actionablePatterns = [
  /^(?:error|fail|failed|failure|fatal|exception|not ok)(?:\b|:)/i,
  /\b(?:AssertionError|TypeError|ReferenceError|SyntaxError)\b/,
  /\b(?:Command failed|Code style issues found|ELIFECYCLE)\b/i,
  /\bERR_[A-Z0-9_]+\b/,
];
const noisePattern =
  /(?:0 errors?|0 failures?|no errors?|without errors?|error count:\s*0|failures?\s*[:=]\s*0)/i;

export const findActionableError = (text) => {
  const match = text
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean)
    .find(
      (line) =>
        actionablePatterns.some((pattern) => pattern.test(line)) &&
        !noisePattern.test(line),
    );
  return match ? match.slice(0, 500) : null;
};

const readExistingLog = (logs = []) =>
  logs.find((candidate) => existsSync(resolve(candidate))) ?? null;

const readMetric = (metricPath) => {
  if (!metricPath || !existsSync(resolve(metricPath))) return null;
  const metric = JSON.parse(readFileSync(resolve(metricPath), 'utf8'));
  if (typeof metric.stage !== 'string' || typeof metric.success !== 'boolean') {
    throw new TypeError(`Invalid CI stage metric: ${metricPath}`);
  }
  return metric;
};

const actionableErrorFromLog = (log) =>
  log ? findActionableError(readFileSync(resolve(log), 'utf8')) : null;

export const buildSummary = ({
  manifest,
  environment,
  jobStatus,
  artifactName,
  failureStep = null,
}) => {
  const declaresMetrics = manifest.stages.some(
    (stage) => typeof stage.metric === 'string',
  );
  const startedStages = manifest.stages
    .map((stage) => {
      const metric = readMetric(stage.metric);
      const log = readExistingLog(stage.logs);
      if (!metric && !log) return null;
      return {
        name: stage.name,
        command: stage.command,
        metric: stage.metric ?? null,
        log,
        result: metric ? (metric.success ? 'passed' : 'failed') : 'unknown',
        exitCode: metric?.exitCode ?? null,
        firstActionableError: actionableErrorFromLog(log),
      };
    })
    .filter(Boolean);
  const failedMetricStage = startedStages.find(
    (stage) => stage.result === 'failed',
  );
  const legacyFailedStage =
    jobStatus !== 'success' && !declaresMetrics
      ? (startedStages.at(-1) ?? null)
      : null;
  const failedVerificationStage = failedMetricStage ?? legacyFailedStage;
  const failed = jobStatus !== 'success' || Boolean(failedMetricStage);

  let failureKind = null;
  let failedStage = null;
  let firstActionableError = null;
  let reproductionCommand = null;
  if (failedVerificationStage) {
    failureKind = 'verification-stage';
    failedStage = failedVerificationStage.name;
    firstActionableError = failedVerificationStage.firstActionableError;
    reproductionCommand = failedVerificationStage.command;
  } else if (failed && failureStep) {
    failureKind = 'infrastructure';
    failedStage = failureStep.name;
    firstActionableError = actionableErrorFromLog(failureStep.log);
    reproductionCommand = failureStep.command ?? null;
  } else if (failed) {
    failureKind = 'infrastructure';
    failedStage = 'job-infrastructure';
  }

  const repository = environment.GITHUB_REPOSITORY ?? null;
  const runId = environment.GITHUB_RUN_ID ?? null;
  const serverUrl = environment.GITHUB_SERVER_URL ?? 'https://github.com';
  const result =
    failedMetricStage && jobStatus === 'success' ? 'failure' : jobStatus;
  const stages = startedStages.map((stage) => ({
    name: stage.name,
    command: stage.command,
    metric: stage.metric,
    log: stage.log,
    result:
      !declaresMetrics && stage.result === 'unknown'
        ? legacyFailedStage
          ? stage === legacyFailedStage
            ? 'failed'
            : 'passed'
          : 'passed'
        : stage.result,
    exitCode: stage.exitCode,
  }));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repository,
    headSha: environment.AGENT_CI_HEAD_SHA ?? environment.GITHUB_SHA ?? null,
    verificationSha: environment.GITHUB_SHA ?? null,
    workflow: environment.GITHUB_WORKFLOW ?? null,
    runId,
    runAttempt: environment.GITHUB_RUN_ATTEMPT ?? null,
    job: environment.GITHUB_JOB ?? job,
    result,
    stale: false,
    failureKind,
    failedStage,
    firstActionableError,
    reproductionCommand,
    stages,
    artifacts: artifactName ? [artifactName] : [],
    runUrl:
      repository && runId
        ? `${serverUrl}/${repository}/actions/runs/${runId}`
        : null,
  };
};

const run = () => {
  if (!manifestPath || !outputPath || !job) {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
    return;
  }
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
  if (!Array.isArray(manifest.stages))
    throw new TypeError('Agent CI manifest must contain a stages array.');
  const failureStepName = process.env.AGENT_CI_FAILURE_STEP?.trim();
  const failureStep = failureStepName
    ? {
        name: failureStepName,
        command: process.env.AGENT_CI_FAILURE_COMMAND?.trim() || null,
        log: process.env.AGENT_CI_FAILURE_LOG?.trim() || null,
      }
    : null;
  const summary = buildSummary({
    manifest,
    environment: process.env,
    jobStatus: process.env.AGENT_CI_JOB_STATUS ?? 'unknown',
    artifactName: artifact,
    failureStep,
  });
  const destination = resolve(outputPath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(
    `## Agent CI handoff\n\n- Result: **${summary.result}**\n- Head: \`${summary.headSha ?? 'unknown'}\`\n- Verification SHA: \`${summary.verificationSha ?? 'unknown'}\`\n- Job: \`${summary.job}\`\n- Failure kind: ${summary.failureKind ? `\`${summary.failureKind}\`` : 'none'}\n- Failed stage: ${summary.failedStage ? `\`${summary.failedStage}\`` : 'none'}\n- Reproduce: ${summary.reproductionCommand ? `\`${summary.reproductionCommand}\`` : 'not applicable'}\n- First actionable error: ${summary.firstActionableError ?? 'none'}\n- Artifact: ${summary.artifacts[0] ? `\`${summary.artifacts[0]}\`` : 'none'}\n`,
  );
};
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) run();
