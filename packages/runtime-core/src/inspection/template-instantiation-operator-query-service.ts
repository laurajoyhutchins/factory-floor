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
import { CommandScopedOperatorQueryService } from '../operator/command-scoped-operator-query-service.js';
import type { OperatorContext, PageRequest } from '../operator/types.js';
import { TemplateInstantiationInspectionService } from './template-instantiation-inspection-service.js';

type CommandDetails = Awaited<ReturnType<RunDetailsQueryService['getRunDetails']>>;

export function projectControlPlaneGlobalFreshness(
  freshness: CommandDetails['projectionFreshness'],
): CommandDetails['projectionFreshness'] {
  return {
    scope: 'control_plane_global',
    staleAfterMs: freshness.staleAfterMs,
    generatedAt: freshness.generatedAt,
    items: freshness.items.map((item) => ({
      projectionName: item.projectionName,
      updatedAt: item.updatedAt,
      stalenessMs: item.stalenessMs,
      stale: item.stale,
    })),
  };
}

export class OperatorQueryService extends CommandScopedOperatorQueryService {
  private readonly instantiations: TemplateInstantiationInspectionService;
  private readonly details: RunDetailsQueryService;

  constructor(inspectionDb: Kysely<Database>, blobs?: ArtifactBlobStore) {
    super(inspectionDb, blobs);
    this.instantiations = new TemplateInstantiationInspectionService(
      inspectionDb,
    );
    this.details = new RunDetailsQueryService(inspectionDb);
  }

  async getCommandDetails(
    context: OperatorContext,
    commandId: string,
    request: RunDetailsRequest = {},
  ) {
    const details = await this.details.getRunDetails(context, commandId, request);
    const { runId, ...rest } = details;
    return {
      commandId: runId,
      ...rest,
      projectionFreshness: projectControlPlaneGlobalFreshness(
        details.projectionFreshness,
      ),
    };
  }

  async listCommandTemplateInstantiations(
    context: OperatorContext,
    commandId: string,
    page: PageRequest = {},
  ) {
    if (
      !context.principal.roles.includes('operator') &&
      !context.principal.roles.includes('admin')
    )
      throw new OperatorAuthorizationError();
    try {
      return await this.instantiations.list({ runId: commandId }, page);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'inspection_error';
      if (code === 'run_not_found')
        throw new OperatorNotFoundError('command_not_found');
      if (['invalid_scope', 'invalid_cursor', 'invalid_limit'].includes(code))
        throw new OperatorValidationError(code);
      throw error;
    }
  }
}