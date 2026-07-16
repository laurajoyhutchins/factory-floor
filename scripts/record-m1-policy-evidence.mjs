import process from 'node:process';
import { Client } from 'pg';
import { randomBytes, createHash } from 'node:crypto';
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
function uuid() {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 5; i >= 0; i -= 1)
    bytes[5 - i] = Number((ms >> BigInt(i * 8)) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function digest(v) {
  return createHash('sha256').update(JSON.stringify(v)).digest('hex');
}
const policy = {
  kind: 'Policy',
  metadata: { name: 'm1.acceptance.operator-inspection', version: '1.0.0' },
  spec: { outcome: 'require_approval' },
};
const c = new Client({ connectionString: databaseUrl });
await c.connect();
try {
  await c.query('begin');
  let {
    rows: [p],
  } = await c.query('select id from policies where name=$1 and version=$2', [
    'm1.acceptance.operator-inspection',
    '1.0.0',
  ]);
  if (!p) {
    const id = uuid();
    await c.query(
      'insert into policies(id,name,version,content_digest,policy) values($1,$2,$3,$4,$5)',
      [
        id,
        'm1.acceptance.operator-inspection',
        '1.0.0',
        digest(policy),
        policy,
      ],
    );
    p = { id };
  }
  const {
    rows: [subject],
  } = await c.query('select id from commands order by created_at desc limit 1');
  if (!subject)
    throw new Error('run an investigation before recording policy evidence');
  const {
    rows: [artifact],
  } = await c.query(
    'select id from artifacts order by created_at desc limit 1',
  );
  let {
    rows: [d],
  } = await c.query(
    'select id from policy_decisions where policy_name=$1 and subject_id=$2',
    ['m1.acceptance.operator-inspection', subject.id],
  );
  if (!d) {
    const id = uuid();
    await c.query(
      `insert into policy_decisions(id,policy_id,policy_name,policy_version,evaluator_version,subject_kind,subject_id,input_artifact_id,normalized_inputs,outcome,reason,modifications) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        p.id,
        'm1.acceptance.operator-inspection',
        '1.0.0',
        'factory-floor-policy-evaluator/1.0.0',
        'command',
        subject.id,
        artifact?.id ?? null,
        { commandId: subject.id, purpose: 'm1 acceptance evidence' },
        'require_approval',
        'Milestone 1 acceptance records durable require-approval decisions without dispatching external effects.',
        [],
      ],
    );
    await c.query(
      'insert into approvals(id,policy_decision_id,status) values($1,$2,$3)',
      [uuid(), id, 'requested'],
    );
    d = { id };
  }
  await c.query('commit');
  globalThis.console.log(
    JSON.stringify({
      status: 'policy-evidence-recorded',
      policyDecisionId: d.id,
    }),
  );
} catch (e) {
  await c.query('rollback').catch(() => {});
  throw e;
} finally {
  await c.end();
}
