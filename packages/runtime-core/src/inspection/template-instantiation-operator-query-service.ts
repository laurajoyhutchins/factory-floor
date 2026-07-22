import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import type { Database } from '@factory-floor/db';
import type { Kysely } from 'kysely';
import {
  OperatorAuthorizationError,
  OperatorNotFoundError,
  OperatorValidationError,
} from '../operator/errors.js';
import {
  RunDetailsQueryService,
  type RunDetailsRequest,
} from '../operator/run-details-query-service.js';
import { RunScopedOperatorQueryService } from '../operator/run-scoped-operator-query-service.js';
import type { OperatorContext, PageRequest } from '../operator/types.js';
import { TemplateInstantiationInspectionService } from './template-instantiation-inspection-service.js';

type RunDetails = Awaited<ReturnType<RunDetailsQueryService['getRunDetails']>>;

export function projectRunSafeFreshness(
  runId: string,
  freshness: RunDetails['projectionFreshness'],
): RunDetails['projectionFreshness'] {
  return {
    staleAfterMs: freshness.staleAfterMs,
    generatedAt: freshness.generatedAt,
    items: freshness.items.map((item) => ({
      id: `${runId}:${item.projectionName}`,
      projectionName: item.projectionName,
      streamKey: runId,
      lastEventId: null,
      lastSequenceNumber: '0',
      updatedAt: item.updatedAt,
      stalenessMs: item.stalenessMs,
      stale: item.stale,
    })),
  };
}

export class OperatorQueryService extends RunScopedOperatorQueryService {
  private readonly instantiations: TemplateInstantiationInspectionService;
  private readonly details: RunDetailsQueryService;

  constructor(inspectionDb: Kysely<Database>, blobs?: ArtifactBlobStore) {
    super(inspectionDb, blobs);
    this.instantiations = new TemplateInstantiationInspectionService(
      inspectionDb,
    );
    this.details = new RunDetailsQueryService(inspectionDb);
  }

  async getRunDetails(
    context: OperatorContext,
    runId: string,
    request: RunDetailsRequest = {},
  ) {
    const details = await this.details.getRunDetails(context, runId, request);
    return {
      ...details,
      projectionFreshness: projectRunSafeFreshness(
        runId,
        details.projectionFreshness,
      ),
    };
  }

  async listRunTemplateInstantiations(
    context: OperatorContext,
    runId: string,
    page: PageRequest = {},
  ) {
    if (
      !context.principal.roles.includes('operator') &&
      !context.principal.roles.includes('admin')
    )
      throw new OperatorAuthorizationError();
    try {
      return await this.instantiations.list({ runId }, page);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'inspection_error';
      if (code === 'run_not_found') throw new OperatorNotFoundError(code);
      if (['invalid_scope', 'invalid_cursor', 'invalid_limit'].includes(code))
        throw new OperatorValidationError(code);
      throw error;
    }
  }
}
