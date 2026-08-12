/* eslint-disable @typescript-eslint/no-explicit-any */
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  createUuidV7,
  type Database,
  type Json,
  type RuntimeDb,
} from '@factory-floor/db';

export type AdmissionOutcome =
  | 'admit'
  | 'defer'
  | 'require_approval'
  | 'suspend'
  | 'reject';

export interface NormalizedBudgetLimit {
  resourceType: string;
  limitQuantity: bigint;
  unit: string;
  exhaustionOutcome: Exclude<AdmissionOutcome, 'admit'>;
}

export interface AdmissionCalculation {
  outcome: AdmissionOutcome;
  remainingBefore: bigint;
  requestedQuantity: bigint;
}

const BUDGET_FIELDS: Record<
  string,
  { resourceType: string; unit: string; scale?: bigint }
> = {
  maximumConcurrentRegions: {
    resourceType: 'concurrent_regions',
    unit: 'count',
  },
  maximumConcurrentExecutions: {
    resourceType: 'concurrent_executions',
    unit: 'count',
  },
  modelTokens: { resourceType: 'model_tokens', unit: 'tokens' },
  networkRequests: { resourceType: 'network_calls', unit: 'calls' },
  humanAttentionMinutes: {
    resourceType: 'human_attention',
    unit: 'minutes',
  },
  dailyMonetaryCostUsd: {
    resourceType: 'monetary_cost',
    unit: 'micro_usd',
    scale: 1_000_000n,
  },
  monetaryCostUsd: {
    resourceType: 'monetary_cost',
    unit: 'micro_usd',
    scale: 1_000_000n,
  },
};

function toScaledInteger(value: unknown, scale = 1n): bigint {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('budget values must be finite non-negative numbers');
  const scaled = value * Number(scale);
  if (!Number.isSafeInteger(scaled))
    throw new Error('budget value cannot be represented exactly');
  return BigInt(scaled);
}

export function normalizeBudgetDeclaration(
  declaration: Record<string, unknown> | undefined,
): NormalizedBudgetLimit[] {
  if (!declaration) return [];
  const normalized: NormalizedBudgetLimit[] = [];
  for (const [field, value] of Object.entries(declaration)) {
    const mapping = BUDGET_FIELDS[field];
    if (!mapping) continue;
    normalized.push({
      resourceType: mapping.resourceType,
      limitQuantity: toScaledInteger(value, mapping.scale),
      unit: mapping.unit,
      exhaustionOutcome: 'defer',
    });
  }
  normalized.sort((left, right) =>
    left.resourceType.localeCompare(right.resourceType),
  );
  return normalized;
}

export function calculateAdmission(input: {
  limitQuantity: bigint;
  consumedQuantity: bigint;
  reservedQuantity: bigint;
  requestedQuantity: bigint;
  exhaustionOutcome: Exclude<AdmissionOutcome, 'admit'>;
}): AdmissionCalculation {
  const remainingBefore =
    input.limitQuantity - input.consumedQuantity - input.reservedQuantity;
  return {
    outcome:
      input.requestedQuantity <= remainingBefore
        ? 'admit'
        : input.exhaustionOutcome,
    remainingBefore,
    requestedQuantity: input.requestedQuantity,
  };
}

export interface ConfigureRegionBudgetsInput {
  regionId: string;
  parentRegionId?: string | null;
  budgets?: Record<string, unknown>;
  source: Json;
}

export interface ReserveResourceInput {
  regionId: string;
  resourceType: string;
  quantity: bigint;
  idempotencyKey: string;
  subjectKind: string;
  subjectId: string;
  executionId?: string | null;
  attemptId?: string | null;
  externalActionId?: string | null;
  attributes?: Json;
}

export interface AdmissionResult {
  outcome: AdmissionOutcome;
  requestId: string;
  reservationIds: string[];
  limitingBudgetId?: string;
  remainingBefore?: bigint;
}

type BudgetRow = {
  id: string;
  resource_type: string;
  limit_quantity: string;
  unit: string;
  exhaustion_outcome: Exclude<AdmissionOutcome, 'admit'>;
};

export class ResourceAdmissionService {
  constructor(private readonly db: Kysely<Database>) {}

  async configureRegionBudgets(input: ConfigureRegionBudgetsInput) {
    return this.db.transaction().execute((trx) =>
      this.configureRegionBudgetsInTransaction(trx, input),
    );
  }

  async configureRegionBudgetsInTransaction(
    trx: Transaction<Database>,
    input: ConfigureRegionBudgetsInput,
  ) {
    const limits = normalizeBudgetDeclaration(input.budgets);
    const desired = new Set(limits.map((limit) => limit.resourceType));

    const existing = await sql<BudgetRow>`
      select id, resource_type, limit_quantity::text, unit, exhaustion_outcome
      from resource_budgets
      where scope_kind = 'region'
        and scope_id = ${input.regionId}
        and retired_at is null
      for update
    `.execute(trx as any);

    for (const row of existing.rows)
      if (!desired.has(row.resource_type))
        await sql`
          update resource_budgets set retired_at = now() where id = ${row.id}
        `.execute(trx as any);

    for (const limit of limits) {
      let parentBudgetId: string | null = null;
      if (input.parentRegionId) {
        const parent = await sql<BudgetRow>`
          select id, resource_type, limit_quantity::text, unit, exhaustion_outcome
          from resource_budgets
          where scope_kind = 'region'
            and scope_id = ${input.parentRegionId}
            and resource_type = ${limit.resourceType}
            and retired_at is null
          for share
        `.execute(trx as any);
        const parentBudget = parent.rows[0];
        if (parentBudget) {
          if (limit.limitQuantity > BigInt(parentBudget.limit_quantity))
            throw new Error(
              `child budget ${limit.resourceType} cannot exceed parent limit`,
            );
          parentBudgetId = parentBudget.id;
        }
      }

      const current = existing.rows.find(
        (row) => row.resource_type === limit.resourceType,
      );
      if (
        current &&
        BigInt(current.limit_quantity) === limit.limitQuantity &&
        current.unit === limit.unit &&
        current.exhaustion_outcome === limit.exhaustionOutcome
      )
        continue;
      if (current)
        await sql`
          update resource_budgets set retired_at = now() where id = ${current.id}
        `.execute(trx as any);

      await sql`
        insert into resource_budgets(
          id, scope_kind, scope_id, parent_budget_id, resource_type,
          limit_quantity, unit, exhaustion_outcome, source
        ) values (
          ${createUuidV7()}, 'region', ${input.regionId}, ${parentBudgetId},
          ${limit.resourceType}, ${limit.limitQuantity.toString()}::bigint,
          ${limit.unit}, ${limit.exhaustionOutcome},
          ${JSON.stringify(input.source)}::jsonb
        )
      `.execute(trx as any);
    }
  }

  async reserve(input: ReserveResourceInput): Promise<AdmissionResult> {
    if (input.quantity < 0n) throw new Error('reservation quantity must be non-negative');
    if (!input.idempotencyKey) throw new Error('idempotency key is required');
    return this.db.transaction().execute((trx) => this.reserveInTransaction(trx, input));
  }

  async reserveInTransaction(
    trx: Transaction<Database>,
    input: ReserveResourceInput,
  ): Promise<AdmissionResult> {
    const prior = await sql<{
      request_id: string;
      reservation_id: string;
    }>`
      select request_id, id as reservation_id
      from resource_reservations
      where idempotency_key = ${input.idempotencyKey}
      order by budget_id
    `.execute(trx as any);
    if (prior.rows.length > 0)
      return {
        outcome: 'admit',
        requestId: prior.rows[0]!.request_id,
        reservationIds: prior.rows.map((row) => row.reservation_id),
      };

    const budgets = await sql<BudgetRow>`
      with recursive ancestors as (
        select id, parent_region_id, 0 as depth
        from regions where id = ${input.regionId}::uuid
        union all
        select parent.id, parent.parent_region_id, ancestors.depth + 1
        from regions parent
        join ancestors on ancestors.parent_region_id = parent.id
      )
      select b.id, b.resource_type, b.limit_quantity::text, b.unit,
             b.exhaustion_outcome
      from ancestors
      join resource_budgets b
        on b.scope_kind = 'region'
       and b.scope_id = ancestors.id::text
       and b.resource_type = ${input.resourceType}
       and b.retired_at is null
      order by ancestors.depth asc, b.id
      for update of b
    `.execute(trx as any);

    const requestId = createUuidV7();
    if (budgets.rows.length === 0) {
      await this.recordDecision(trx, {
        input,
        requestId,
        outcome: 'admit',
        reason: 'no applicable budget',
      });
      return { outcome: 'admit', requestId, reservationIds: [] };
    }

    for (const budget of budgets.rows) {
      const reserved = await sql<{ quantity: string }>`
        select coalesce(sum(quantity), 0)::text as quantity
        from resource_reservations
        where budget_id = ${budget.id}::uuid and status = 'reserved'
      `.execute(trx as any);
      const consumed = await sql<{ quantity: string }>`
        with recursive descendants as (
          select id from regions where id = ${budget.id}::uuid and false
          union all select id from regions where false
        )
        select coalesce(sum(rl.quantity), 0)::text as quantity
        from resource_ledger rl
        where rl.resource_type = ${input.resourceType}
          and rl.region_id in (
            with recursive region_descendants as (
              select id from regions
              where id::text = (select scope_id from resource_budgets where id = ${budget.id}::uuid)
              union all
              select child.id from regions child
              join region_descendants parent on child.parent_region_id = parent.id
            ) select id from region_descendants
          )
      `.execute(trx as any);
      const decision = calculateAdmission({
        limitQuantity: BigInt(budget.limit_quantity),
        consumedQuantity: BigInt(consumed.rows[0]?.quantity ?? '0'),
        reservedQuantity: BigInt(reserved.rows[0]?.quantity ?? '0'),
        requestedQuantity: input.quantity,
        exhaustionOutcome: budget.exhaustion_outcome,
      });
      if (decision.outcome !== 'admit') {
        await this.recordDecision(trx, {
          input,
          requestId,
          budgetId: budget.id,
          outcome: decision.outcome,
          remainingBefore: decision.remainingBefore,
          reason: `budget exhausted for ${input.resourceType}`,
        });
        return {
          outcome: decision.outcome,
          requestId,
          reservationIds: [],
          limitingBudgetId: budget.id,
          remainingBefore: decision.remainingBefore,
        };
      }
    }

    const reservationIds: string[] = [];
    for (const budget of budgets.rows) {
      const reservationId = createUuidV7();
      reservationIds.push(reservationId);
      await sql`
        insert into resource_reservations(
          id, request_id, budget_id, region_id, execution_id, attempt_id,
          external_action_id, idempotency_key, quantity, attributes
        ) values (
          ${reservationId}, ${requestId}, ${budget.id}, ${input.regionId},
          ${input.executionId ?? null}, ${input.attemptId ?? null},
          ${input.externalActionId ?? null}, ${input.idempotencyKey},
          ${input.quantity.toString()}::bigint,
          ${JSON.stringify(input.attributes ?? {})}::jsonb
        )
      `.execute(trx as any);
      await this.recordDecision(trx, {
        input,
        requestId,
        budgetId: budget.id,
        reservationId,
        outcome: 'admit',
        reason: `reserved ${input.resourceType}`,
      });
    }
    return { outcome: 'admit', requestId, reservationIds };
  }

  async release(requestId: string) {
    await sql`
      update resource_reservations
      set status = 'released', reconciled_at = now()
      where request_id = ${requestId}::uuid and status = 'reserved'
    `.execute(this.db as any);
  }

  async reconcile(requestId: string, actualQuantity: bigint) {
    if (actualQuantity < 0n) throw new Error('actual quantity must be non-negative');
    return this.db.transaction().execute(async (trx) => {
      const reservations = await sql<any>`
        select rr.*, b.resource_type, b.unit
        from resource_reservations rr
        join resource_budgets b on b.id = rr.budget_id
        where rr.request_id = ${requestId}::uuid
        order by rr.budget_id
        for update of rr
      `.execute(trx as any);
      if (reservations.rows.length === 0) return false;
      const first = reservations.rows[0];
      await sql`
        insert into resource_ledger(
          id, region_id, execution_id, attempt_id, external_action_id,
          resource_type, quantity, unit, attributes
        ) values (
          ${createUuidV7()}, ${first.region_id}, ${first.execution_id},
          ${first.attempt_id}, ${first.external_action_id},
          ${first.resource_type}, ${actualQuantity.toString()}::bigint,
          ${first.unit},
          ${JSON.stringify({ admission_request_id: requestId })}::jsonb
        ) on conflict do nothing
      `.execute(trx as any);
      await sql`
        update resource_reservations
        set status = 'reconciled', actual_quantity = ${actualQuantity.toString()}::bigint,
            reconciled_at = now()
        where request_id = ${requestId}::uuid and status = 'reserved'
      `.execute(trx as any);
      return true;
    });
  }

  private async recordDecision(
    trx: RuntimeDb,
    args: {
      input: ReserveResourceInput;
      requestId: string;
      budgetId?: string;
      reservationId?: string;
      outcome: AdmissionOutcome;
      reason: string;
      remainingBefore?: bigint;
    },
  ) {
    await sql`
      insert into admission_decisions(
        id, subject_kind, subject_id, budget_id, resource_type, outcome,
        reason, requested_quantity, remaining_before, request_id, reservation_id
      ) values (
        ${createUuidV7()}, ${args.input.subjectKind}, ${args.input.subjectId},
        ${args.budgetId ?? null}, ${args.input.resourceType}, ${args.outcome},
        ${args.reason}, ${args.input.quantity.toString()}::bigint,
        ${args.remainingBefore?.toString() ?? null}::bigint,
        ${args.requestId}, ${args.reservationId ?? null}
      )
    `.execute(trx as any);
  }
}
