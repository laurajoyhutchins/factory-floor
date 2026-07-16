import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { Client } from 'pg';

const outDir =
  process.env.FACTORY_FLOOR_EVIDENCE_DIR ?? '.factory-floor/evidence/m1';
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const startedAt =
  process.env.FACTORY_FLOOR_ACCEPTANCE_STARTED_AT ?? new Date().toISOString();
const redact = (value) =>
  typeof value === 'string'
    ? value
        .replace(/Bearer\s+[^\s"]+/gi, 'Bearer [REDACTED]')
        .replace(/factory_floor_dev_password/g, '[REDACTED]')
    : value;
async function query(sql, params = []) {
  const c = new Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}
async function main() {
  await mkdir(outDir, { recursive: true });
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const env = {
    node: execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(),
    pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
    uv: execFileSync('uv', ['--version'], { encoding: 'utf8' }).trim(),
  };
  const ledgerText = execFileSync('pnpm', ['conformance:check'], {
    encoding: 'utf8',
  }).trim();
  const commands = await query(
    'select id, command_type, region_id, correlation_id, status, source_kind, created_at from commands order by created_at',
  );
  const executions = await query(
    `select e.id, e.delivery_id, e.region_id, e.component_instance_id, ci.name as component_name, e.lifecycle_epoch, e.status, e.failure, e.created_at, e.completed_at from executions e left join component_instances ci on ci.id=e.component_instance_id order by e.created_at, e.id`,
  );
  const attempts = await query(
    `select a.id, a.execution_id, a.attempt_number, a.status, a.failure, a.started_at, a.completed_at, a.abandoned_at from execution_attempts a order by a.created_at, a.attempt_number`,
  );
  const deliveries = await query(
    'select id, region_id, target_component_instance_id, target_port_name, source_command_id, source_event_id, correlation_id, status, attempts_count, lease_owner, lease_expires_at, created_at from deliveries order by created_at, id',
  );
  const artifacts = await query(
    `select a.id, a.digest_algorithm, a.digest, a.size_bytes, a.schema_id, s.name as schema_name, s.version as schema_version, s.content_digest as schema_digest, a.state, a.media_type, case when a.committed_locator is null then null else '[REDACTED_LOCATOR]' end as committed_locator, a.provenance, a.tombstoned_at, a.created_at from artifacts a join artifact_schemas s on s.id=a.schema_id order by a.created_at, a.id`,
  );
  const derivations = await query(
    'select id, artifact_id, source_artifact_id, execution_id, attempt_id, relation, created_at from artifact_derivations order by created_at, id',
  );
  const resources = await query(
    'select id, region_id, execution_id, attempt_id, external_action_id, resource_type, quantity, unit, attributes, created_at from resource_ledger order by created_at, id',
  );
  const events = await query(
    'select id, region_id, event_type, correlation_id, source_kind, source_command_id, source_event_id, source_execution_id, source_attempt_id, source_component_instance_id, source_port_name, created_at from events order by created_at, id',
  );
  const policyDecisions = await query(
    `select d.id, d.policy_id, d.policy_name, d.policy_version, d.evaluator_version, d.subject_kind, d.subject_id, d.input_artifact_id, d.normalized_inputs, d.outcome, d.reason, d.modifications, a.id as approval_id, a.status as approval_status, d.created_at from policy_decisions d left join approvals a on a.policy_decision_id=d.id order by d.created_at, d.id`,
  );
  const projections = await query(
    'select projection_name, stream_key, last_event_id, last_sequence_number, updated_at from projection_checkpoints order by projection_name',
  );
  const duplicateOutputs = await query(
    `select execution_id, port_name, count(*)::int as count from execution_outputs group by execution_id, port_name having count(*) > 1`,
  );
  const duplicateDeliveries = await query(
    `select source_event_id, target_component_instance_id, target_port_name, count(*)::int as count from deliveries where source_event_id is not null group by source_event_id, target_component_instance_id, target_port_name having count(*) > 1`,
  );
  const unresolvedDeliveries = deliveries.filter(
    (d) => !['completed', 'cancelled', 'dead_lettered'].includes(d.status),
  );
  const evidence = {
    schemaVersion: 1,
    commitSha,
    startedAt,
    completedAt: new Date().toISOString(),
    environment: env,
    conformanceLedger: { summary: ledgerText },
    commands,
    executions,
    attempts,
    deliveries,
    artifacts,
    derivations,
    resources,
    events,
    policyDecisions,
    projections,
    checks: {
      duplicateOutputs,
      duplicateDeliveries,
      unresolvedDeliveries,
      terminalDeliveries: unresolvedDeliveries.length === 0,
      artifactIdentity: artifacts.every(
        (a) =>
          a.id &&
          a.digest_algorithm === 'sha256' &&
          /^[a-f0-9]{64}$/.test(a.digest) &&
          a.schema_id &&
          a.schema_digest &&
          a.media_type &&
          a.state,
      ),
      resourceAttribution: resources.every(
        (r) =>
          r.region_id &&
          r.resource_type &&
          r.quantity !== null &&
          r.unit &&
          (r.execution_id || r.external_action_id),
      ),
      policyDecisionDurability: policyDecisions.every(
        (p) =>
          p.policy_name &&
          p.policy_version &&
          p.evaluator_version &&
          p.subject_kind &&
          p.subject_id &&
          p.normalized_inputs &&
          p.outcome &&
          p.reason !== null &&
          p.modifications !== null,
      ),
      deferred: ['M1-CONF-006', 'M1-CONF-007', 'M1-CONF-015'],
      cleanCodespace:
        'pending unless this command was run from a newly created Codespace or equivalent clean checkout',
    },
  };
  await writeFile(
    join(outDir, 'acceptance-evidence.json'),
    JSON.stringify(evidence, (k, v) => redact(v), 2),
  );
  const md = `# Milestone 1 acceptance evidence\n\n- Commit: ${commitSha}\n- Started: ${startedAt}\n- Completed: ${evidence.completedAt}\n- Commands: ${commands.length}\n- Logical executions: ${executions.length}\n- Attempts: ${attempts.length}\n- Deliveries: ${deliveries.length}\n- Artifacts: ${artifacts.length}\n- Resource entries: ${resources.length}\n- Policy decisions: ${policyDecisions.length}\n- Duplicate outputs: ${duplicateOutputs.length}\n- Duplicate deliveries: ${duplicateDeliveries.length}\n- Non-terminal deliveries: ${unresolvedDeliveries.length}\n- Deferred invariants: ${evidence.checks.deferred.join(', ')}\n\nSee \`acceptance-evidence.json\` for sanitized machine-readable details.\n`;
  await writeFile(join(outDir, 'SUMMARY.md'), md);
  globalThis.console.log(
    JSON.stringify(
      { status: 'evidence-written', outDir, checks: evidence.checks },
      null,
      2,
    ),
  );
  if (
    unresolvedDeliveries.length ||
    duplicateOutputs.length ||
    duplicateDeliveries.length ||
    !evidence.checks.artifactIdentity ||
    !evidence.checks.resourceAttribution ||
    !evidence.checks.policyDecisionDurability
  )
    process.exit(1);
}
main().catch((e) => {
  globalThis.console.error(e);
  process.exit(1);
});
