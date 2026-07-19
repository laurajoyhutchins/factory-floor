import console from 'node:console';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';

const readOption = (name, fallback) => {
  const index = process.argv.indexOf(name, 2);
  return index === -1 ? fallback : process.argv[index + 1];
};

const policyPath = resolve(readOption('--policy', 'quality-gates.json'));
const workflowPath = resolve(
  readOption(
    '--workflow',
    '.github/workflows/repository-verification.yml',
  ),
);
const violations = [];

const record = (condition, message) => {
  if (!condition) {
    violations.push(message);
  }
};

let policy;
let workflow;
try {
  policy = JSON.parse(readFileSync(policyPath, 'utf8'));
} catch (error) {
  violations.push(
    `Unable to read quality-gate policy ${policyPath}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
try {
  workflow = parse(readFileSync(workflowPath, 'utf8'));
} catch (error) {
  violations.push(
    `Unable to read verification workflow ${workflowPath}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

if (policy) {
  record(policy.schemaVersion === 1, 'schemaVersion must be 1');

  const requireNumber = (value, description, minimum, maximum) => {
    record(
      typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= minimum &&
        value <= maximum,
      `${description} must be a finite number from ${minimum} through ${maximum}`,
    );
  };

  requireNumber(
    policy.durationTargetsSeconds?.fastVerificationP95,
    'durationTargetsSeconds.fastVerificationP95',
    1,
    3600,
  );
  requireNumber(
    policy.durationTargetsSeconds?.completeVerificationP95,
    'durationTargetsSeconds.completeVerificationP95',
    1,
    7200,
  );
  requireNumber(
    policy.reliabilityTargets?.maximumFlakyRerunPercent,
    'reliabilityTargets.maximumFlakyRerunPercent',
    0,
    100,
  );
  requireNumber(
    policy.futureCoverageRatchet?.changedLinesPercent,
    'futureCoverageRatchet.changedLinesPercent',
    0,
    100,
  );
  requireNumber(
    policy.futureCoverageRatchet?.changedBranchesPercent,
    'futureCoverageRatchet.changedBranchesPercent',
    0,
    100,
  );
  record(
    typeof policy.futureCoverageRatchet?.totalCoverageMustNotDecrease ===
      'boolean',
    'futureCoverageRatchet.totalCoverageMustNotDecrease must be boolean',
  );
  record(
    typeof policy.futureCoverageRatchet?.enforced === 'boolean',
    'futureCoverageRatchet.enforced must be boolean',
  );
  requireNumber(
    policy.changeReviewThresholds?.executableLines,
    'changeReviewThresholds.executableLines',
    1,
    100000,
  );
  requireNumber(
    policy.changeReviewThresholds?.files,
    'changeReviewThresholds.files',
    1,
    10000,
  );
  record(
    Array.isArray(policy.requiredJobs) && policy.requiredJobs.length > 0,
    'requiredJobs must be a non-empty array',
  );
  record(
    Array.isArray(policy.requiredStages) && policy.requiredStages.length > 0,
    'requiredStages must be a non-empty array',
  );
  record(
    policy.supplyChain?.requireImmutableActionReferences === true,
    'supplyChain.requireImmutableActionReferences must be true',
  );
}

if (policy && workflow) {
  const jobs = workflow.jobs ?? {};
  const allSteps = Object.values(jobs).flatMap((job) => job.steps ?? []);
  const runCommands = allSteps.map((step) => step.run ?? '').join('\n');

  for (const jobName of policy.requiredJobs ?? []) {
    record(
      Boolean(jobs[jobName]),
      `Required workflow job is missing: ${jobName}`,
    );
  }

  for (const stage of policy.requiredStages ?? []) {
    record(
      runCommands.includes(`node scripts/run-ci-stage.mjs --stage ${stage}`),
      `Required measured verification stage is missing: ${stage}`,
    );
  }

  record(
    runCommands.includes('node scripts/summarize-ci-metrics.mjs'),
    'Workflow must summarize CI metrics',
  );

  if (policy.supplyChain?.requireImmutableActionReferences === true) {
    for (const step of allSteps) {
      const reference = step.uses;
      if (typeof reference !== 'string' || reference.startsWith('./')) {
        continue;
      }
      record(
        /^[^@]+@[0-9a-f]{40}$/.test(reference),
        `Action reference must use an immutable 40-character SHA: ${reference}`,
      );
    }
  }

  for (const [jobName, job] of Object.entries(jobs)) {
    const uploadPaths = (job.steps ?? [])
      .filter((step) =>
        step.uses?.startsWith('actions/upload-artifact@'),
      )
      .map((step) => step.with?.path ?? '')
      .join('\n');
    record(
      uploadPaths.includes('.factory-floor/ci-metrics/'),
      `Workflow job ${jobName} must upload .factory-floor/ci-metrics/`,
    );
  }

  record(
    jobs['m1-acceptance']?.needs === 'service-verification',
    'm1-acceptance must depend on service-verification',
  );
}

if (violations.length > 0) {
  console.error('CI quality-gate validation failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `CI quality gates are valid (${policy.requiredJobs.length} jobs, ${policy.requiredStages.length} stages)`,
  );
}
