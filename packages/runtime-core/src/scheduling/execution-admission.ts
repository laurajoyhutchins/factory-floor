import type { Database } from '@factory-floor/db';
import type { Transaction } from 'kysely';
import {
  type AdmissionResult,
  ResourceAdmissionService,
} from './resource-admission-service.js';

export interface ExecutionLeaseAdmissionInput {
  regionId: string;
  executionId: string;
  attemptId?: string | null;
}

/**
 * Reserve one concurrent-execution unit before an execution attempt may lease.
 *
 * The idempotency key is execution-scoped so retries do not consume another
 * concurrent-execution unit. The caller must keep this call in the same
 * transaction as the lease mutation so a failed lease cannot strand a
 * reservation.
 */
export function reserveExecutionLeaseAdmission(
  admission: ResourceAdmissionService,
  trx: Transaction<Database>,
  input: ExecutionLeaseAdmissionInput,
): Promise<AdmissionResult> {
  return admission.reserveInTransaction(trx, {
    regionId: input.regionId,
    resourceType: 'concurrent_executions',
    quantity: 1n,
    idempotencyKey: `execution:${input.executionId}:concurrent-executions`,
    subjectKind: 'execution',
    subjectId: input.executionId,
    executionId: input.executionId,
    attemptId: input.attemptId ?? null,
    attributes: {
      admission_boundary: 'execution_lease',
    },
  });
}

export function executionLeaseMayProceed(result: AdmissionResult): boolean {
  return result.outcome === 'admit';
}
