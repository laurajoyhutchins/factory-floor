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

  getRunDetails(
    context: OperatorContext,
    runId: string,
    request: RunDetailsRequest = {},
  ) {
    return this.details.getRunDetails(context, runId, request);
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
