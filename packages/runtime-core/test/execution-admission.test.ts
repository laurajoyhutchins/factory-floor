import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@factory-floor/db';
import type { Transaction } from 'kysely';
import {
  executionLeaseMayProceed,
  reserveExecutionLeaseAdmission,
} from '../src/scheduling/execution-admission.js';
import type { ResourceAdmissionService } from '../src/scheduling/resource-admission-service.js';

describe('execution lease admission', () => {
  it('reserves exactly one execution-scoped concurrent unit', async () => {
    const reserveInTransaction = vi.fn().mockResolvedValue({
      outcome: 'admit',
      requestId: 'request-1',
      reservationIds: ['reservation-1'],
    });
    const admission = {
      reserveInTransaction,
    } as unknown as ResourceAdmissionService;
    const trx = {} as Transaction<Database>;

    await reserveExecutionLeaseAdmission(admission, trx, {
      regionId: 'region-1',
      executionId: 'execution-1',
      attemptId: 'attempt-1',
    });

    expect(reserveInTransaction).toHaveBeenCalledWith(trx, {
      regionId: 'region-1',
      resourceType: 'concurrent_executions',
      quantity: 1n,
      idempotencyKey: 'execution:execution-1:concurrent-executions',
      subjectKind: 'execution',
      subjectId: 'execution-1',
      executionId: 'execution-1',
      attemptId: 'attempt-1',
      attributes: { admission_boundary: 'execution_lease' },
    });
  });

  it('allows only an admit outcome to cross the lease boundary', () => {
    expect(
      executionLeaseMayProceed({
        outcome: 'admit',
        requestId: 'request-1',
        reservationIds: [],
      }),
    ).toBe(true);
    expect(
      executionLeaseMayProceed({
        outcome: 'defer',
        requestId: 'request-2',
        reservationIds: [],
      }),
    ).toBe(false);
    expect(
      executionLeaseMayProceed({
        outcome: 'require_approval',
        requestId: 'request-3',
        reservationIds: [],
      }),
    ).toBe(false);
  });
});
