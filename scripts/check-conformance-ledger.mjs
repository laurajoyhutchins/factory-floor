import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import YAML from 'yaml';

const repoRoot = process.cwd();
const ledgerPath =
  process.argv[2] ?? 'docs/conformance/durable-reactive-graph-ledger.yaml';
const absoluteLedgerPath = isAbsolute(ledgerPath)
  ? ledgerPath
  : join(repoRoot, ledgerPath);
const ledger = YAML.parse(readFileSync(absoluteLedgerPath, 'utf8'));
const errors = [];
const requiredReferenceInvariants = Array.from(
  { length: 18 },
  (_, index) => index + 1,
);
const requiredGroups = new Set([
  'Identity and attribution',
  'Artifact integrity and provenance',
  'Authority and policy',
  'Dynamic construction',
  'Lifecycle and recovery',
  'Resource and delivery accounting',
  'Replay and side-effect safety',
  'Trust boundaries',
  'Atomicity and idempotency',
]);
const allowedCoverage = new Set(['automated', 'manual', 'deferred']);
const allowedVerification = new Set(['passed', 'pending', 'deferred']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function repoPathExists(value) {
  if (!nonEmptyString(value)) return false;
  const withoutAnchor = value.split('#')[0];
  const absolute = isAbsolute(withoutAnchor)
    ? withoutAnchor
    : join(repoRoot, withoutAnchor);
  return existsSync(absolute);
}

function validateEvidence(entry, label) {
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
    errors.push(`${label}: automated coverage requires evidence`);
    return;
  }
  for (const [index, item] of entry.evidence.entries()) {
    const evidenceLabel = `${label}.evidence[${index}]`;
    if (!item || typeof item !== 'object') {
      errors.push(`${evidenceLabel}: must be an object`);
      continue;
    }
    if (!nonEmptyString(item.path))
      errors.push(`${evidenceLabel}: path is required`);
    else if (!repoPathExists(item.path))
      errors.push(`${evidenceLabel}: path does not exist: ${item.path}`);
    if (!nonEmptyString(item.assertion))
      errors.push(`${evidenceLabel}: assertion is required`);
  }
}

function validateManual(entry, label) {
  const manual = entry.manualAcceptance;
  if (!manual || typeof manual !== 'object') {
    errors.push(`${label}: manual coverage requires manualAcceptance`);
    return;
  }
  if (!nonEmptyString(manual.proof))
    errors.push(`${label}: manualAcceptance.proof is required`);
  if (manual.tracking !== undefined && !repoPathExists(manual.tracking))
    errors.push(
      `${label}: manualAcceptance.tracking does not exist: ${manual.tracking}`,
    );
}

function validateDeferred(entry, label) {
  if (!nonEmptyString(entry.rationale))
    errors.push(`${label}: deferred coverage requires rationale`);
  if (!nonEmptyString(entry.targetMilestone))
    errors.push(`${label}: deferred coverage requires targetMilestone`);
}

function validateCoverage(entry, label) {
  if (!allowedCoverage.has(entry.coverage))
    errors.push(`${label}: coverage must be automated, manual, or deferred`);
  if (!allowedVerification.has(entry.verification))
    errors.push(`${label}: verification must be passed, pending, or deferred`);

  if (entry.coverage === 'automated') {
    if (entry.verification !== 'passed')
      errors.push(`${label}: automated coverage must be verified as passed`);
    validateEvidence(entry, label);
  } else if (entry.coverage === 'manual') {
    if (!['passed', 'pending'].includes(entry.verification))
      errors.push(`${label}: manual coverage must be passed or pending`);
    validateManual(entry, label);
  } else if (entry.coverage === 'deferred') {
    if (entry.verification !== 'deferred')
      errors.push(`${label}: deferred coverage must be verified as deferred`);
    validateDeferred(entry, label);
  }
}

if (!ledger || typeof ledger !== 'object') {
  errors.push('ledger must be an object');
} else {
  if (ledger.version !== 2) errors.push('ledger version must be 2');
  if (!nonEmptyString(ledger.milestone)) errors.push('milestone is required');
  if (!repoPathExists(ledger.reference))
    errors.push(`reference does not exist: ${ledger.reference}`);
  if (!nonEmptyString(ledger.completionRule))
    errors.push('completionRule is required');

  if (!Array.isArray(ledger.invariants)) {
    errors.push('ledger must contain an invariants array');
  } else {
    const seenIds = new Set();
    const seenReferences = new Set();
    const seenGroups = new Set();

    for (const [index, invariant] of ledger.invariants.entries()) {
      const label = invariant?.id ?? `invariants[${index}]`;
      if (!invariant || typeof invariant !== 'object') {
        errors.push(`${label}: entry must be an object`);
        continue;
      }
      for (const field of ['id', 'group', 'requirement', 'source']) {
        if (!nonEmptyString(invariant[field]))
          errors.push(`${label}: ${field} is required`);
      }
      if (!/^M1-CONF-\d{3}$/.test(invariant.id ?? ''))
        errors.push(`${label}: id must match M1-CONF-001`);
      if (seenIds.has(invariant.id)) errors.push(`${label}: duplicate id`);
      seenIds.add(invariant.id);

      if (!Number.isInteger(invariant.referenceInvariant))
        errors.push(`${label}: referenceInvariant must be an integer`);
      else if (seenReferences.has(invariant.referenceInvariant))
        errors.push(
          `${label}: duplicate referenceInvariant ${invariant.referenceInvariant}`,
        );
      seenReferences.add(invariant.referenceInvariant);

      if (!requiredGroups.has(invariant.group))
        errors.push(`${label}: unknown group "${invariant.group}"`);
      seenGroups.add(invariant.group);

      if (!repoPathExists(invariant.source))
        errors.push(`${label}: source does not exist: ${invariant.source}`);
      validateCoverage(invariant, label);
    }

    for (const referenceInvariant of requiredReferenceInvariants) {
      if (!seenReferences.has(referenceInvariant))
        errors.push(`missing reference invariant ${referenceInvariant}`);
    }
    for (const referenceInvariant of seenReferences) {
      if (!requiredReferenceInvariants.includes(referenceInvariant))
        errors.push(`unexpected reference invariant ${referenceInvariant}`);
    }
    if (ledger.invariants.length !== requiredReferenceInvariants.length)
      errors.push(
        `expected exactly ${requiredReferenceInvariants.length} invariants, found ${ledger.invariants.length}`,
      );
    for (const group of requiredGroups) {
      if (!seenGroups.has(group))
        errors.push(`missing invariant group: ${group}`);
    }
  }

  if (!Array.isArray(ledger.acceptanceCriteria)) {
    errors.push('ledger must contain an acceptanceCriteria array');
  } else {
    const seenAcceptanceIds = new Set();
    for (const [index, criterion] of ledger.acceptanceCriteria.entries()) {
      const label = criterion?.id ?? `acceptanceCriteria[${index}]`;
      if (!criterion || typeof criterion !== 'object') {
        errors.push(`${label}: entry must be an object`);
        continue;
      }
      if (!/^M1-ACCEPT-[A-Z-]+$/.test(criterion.id ?? ''))
        errors.push(`${label}: id must match M1-ACCEPT-NAME`);
      if (seenAcceptanceIds.has(criterion.id))
        errors.push(`${label}: duplicate id`);
      seenAcceptanceIds.add(criterion.id);
      if (!nonEmptyString(criterion.requirement))
        errors.push(`${label}: requirement is required`);
      validateCoverage(criterion, label);
    }
  }
}

if (errors.length > 0) {
  globalThis.console.error(
    `Conformance ledger check failed for ${ledgerPath}:`,
  );
  for (const error of errors) globalThis.console.error(`- ${error}`);
  process.exit(1);
}

const allEntries = [...ledger.invariants, ...ledger.acceptanceCriteria];
const counts = Object.fromEntries(
  [...allowedVerification].map((status) => [
    status,
    allEntries.filter((entry) => entry.verification === status).length,
  ]),
);
globalThis.console.log(
  `Conformance ledger check passed: ${ledger.invariants.length} normative invariants; ${counts.passed} passed, ${counts.pending} pending, ${counts.deferred} deferred across invariants and acceptance criteria.`,
);
