import process from 'node:process';
import { createDatabase } from '../packages/db/src/index.js';
import {
  PolicyDecisionService,
  RegistrationService,
} from '../packages/runtime-core/src/index.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor';
const db = createDatabase(databaseUrl);

try {
  await new RegistrationService(db).registerPolicy({
    apiVersion: 'factory-floor.dev/v1alpha1',
    kind: 'Policy',
    metadata: {
      name: 'm1.acceptance.operator-inspection',
      version: '1.0.0',
    },
    spec: {
      outcome: 'require_approval',
      reason:
        'Milestone 1 acceptance requires an inspectable approval relationship without dispatching an external effect.',
    },
  });

  const subject = await db
    .selectFrom('commands')
    .select('id')
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (!subject)
    throw new Error('run an investigation before recording policy evidence');
  const artifact = await db
    .selectFrom('artifacts')
    .select('id')
    .orderBy('created_at', 'desc')
    .executeTakeFirst();

  const result = await new PolicyDecisionService(db).evaluate({
    policyName: 'm1.acceptance.operator-inspection',
    policyVersion: '1.0.0',
    subjectKind: 'command',
    subjectId: subject.id,
    inputArtifactId: artifact?.id ?? null,
    normalizedInputs: {
      commandId: subject.id,
      purpose: 'm1 acceptance evidence',
    },
  });

  globalThis.console.log(
    JSON.stringify({ status: 'policy-evidence-recorded', ...result }),
  );
} finally {
  await db.destroy();
}
