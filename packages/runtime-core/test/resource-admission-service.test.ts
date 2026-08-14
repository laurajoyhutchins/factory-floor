import { describe, expect, it } from 'vitest';
import {
  calculateAdmission,
  normalizeBudgetDeclaration,
} from '../src/scheduling/resource-admission-service.js';

describe('resource admission', () => {
  it('normalizes supported declaration budgets deterministically', () => {
    expect(
      normalizeBudgetDeclaration({
        modelTokens: 25_000,
        monetaryCostUsd: 2,
        networkRequests: 25,
        maximumConcurrentExecutions: 3,
      }),
    ).toEqual([
      {
        resourceType: 'concurrent_executions',
        limitQuantity: 3n,
        unit: 'count',
        exhaustionOutcome: 'defer',
      },
      {
        resourceType: 'model_tokens',
        limitQuantity: 25_000n,
        unit: 'tokens',
        exhaustionOutcome: 'defer',
      },
      {
        resourceType: 'monetary_cost',
        limitQuantity: 2_000_000n,
        unit: 'micro_usd',
        exhaustionOutcome: 'defer',
      },
      {
        resourceType: 'network_calls',
        limitQuantity: 25n,
        unit: 'calls',
        exhaustionOutcome: 'defer',
      },
    ]);
  });

  it('admits exactly through remaining capacity', () => {
    expect(
      calculateAdmission({
        limitQuantity: 10n,
        consumedQuantity: 4n,
        reservedQuantity: 3n,
        requestedQuantity: 3n,
        exhaustionOutcome: 'defer',
      }),
    ).toEqual({
      outcome: 'admit',
      remainingBefore: 3n,
      requestedQuantity: 3n,
    });
  });

  it('uses the configured deterministic exhaustion outcome', () => {
    expect(
      calculateAdmission({
        limitQuantity: 10n,
        consumedQuantity: 8n,
        reservedQuantity: 1n,
        requestedQuantity: 2n,
        exhaustionOutcome: 'require_approval',
      }),
    ).toEqual({
      outcome: 'require_approval',
      remainingBefore: 1n,
      requestedQuantity: 2n,
    });
  });

  it('rejects negative or inexact declaration values', () => {
    expect(() => normalizeBudgetDeclaration({ modelTokens: -1 })).toThrow();
    expect(() =>
      normalizeBudgetDeclaration({ monetaryCostUsd: 0.0000001 }),
    ).toThrow();
  });
});
