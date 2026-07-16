import { createUuidV7, type Database, type Json } from '@factory-floor/db';
import { sql, type Kysely } from 'kysely';

export type PolicyOutcome = 'deny' | 'require_approval' | 'modify' | 'allow';

export interface EvaluatePolicyInput {
  policyName: string;
  policyVersion: string;
  subjectKind: string;
  subjectId: string;
  normalizedInputs: Json;
  inputArtifactId?: string | null;
}

export interface PolicyDecisionResult {
  decisionId: string;
  approvalId: string | null;
  outcome: PolicyOutcome;
  reason: string;
  modifications: Json;
}

interface PolicySpec {
  outcome?: unknown;
  reason?: unknown;
  modifications?: unknown;
}

function policySpec(value: Json): PolicySpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('registered policy must be an object');
  const spec = value.spec;
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec))
    throw new Error('registered policy spec must be an object');
  return spec as PolicySpec;
}

function policyOutcome(value: unknown): PolicyOutcome {
  if (
    value === 'deny' ||
    value === 'require_approval' ||
    value === 'modify' ||
    value === 'allow'
  )
    return value;
  throw new Error('registered policy has an unsupported outcome');
}

export class PolicyDecisionService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly evaluatorVersion = 'factory-floor-policy-evaluator/1.0.0',
    private readonly clock = () => new Date(),
  ) {}

  async evaluate(input: EvaluatePolicyInput): Promise<PolicyDecisionResult> {
    if (!input.subjectKind.trim()) throw new Error('subjectKind is required');
    return this.db.transaction().execute(async (trx) => {
      const policy = await trx
        .selectFrom('policies')
        .selectAll()
        .where('name', '=', input.policyName)
        .where('version', '=', input.policyVersion)
        .where('retired_at', 'is', null)
        .executeTakeFirst();
      if (!policy) throw new Error('policy_not_found');

      const spec = policySpec(policy.policy);
      const outcome = policyOutcome(spec.outcome);
      const reason =
        typeof spec.reason === 'string' && spec.reason.trim()
          ? spec.reason
          : `Policy ${policy.name}@${policy.version} evaluated to ${outcome}.`;
      const modifications: Json =
        outcome === 'modify' && Array.isArray(spec.modifications)
          ? (spec.modifications as Json)
          : [];
      const decisionId = createUuidV7();
      const now = this.clock();

      await trx
        .insertInto('policy_decisions')
        .values({
          id: decisionId,
          policy_id: policy.id,
          policy_name: policy.name,
          policy_version: policy.version,
          evaluator_version: this.evaluatorVersion,
          subject_kind: input.subjectKind,
          subject_id: input.subjectId,
          input_artifact_id: input.inputArtifactId ?? null,
          normalized_inputs: input.normalizedInputs,
          outcome,
          reason,
          modifications: sql<Json>`${JSON.stringify(modifications)}::jsonb`,
        })
        .execute();

      let approvalId: string | null = null;
      if (outcome === 'require_approval') {
        approvalId = createUuidV7();
        await trx
          .insertInto('approvals')
          .values({
            id: approvalId,
            policy_decision_id: decisionId,
            status: 'requested',
            requested_at: now,
            decided_at: null,
            decided_by: null,
          })
          .execute();
      }

      return { decisionId, approvalId, outcome, reason, modifications };
    });
  }
}
