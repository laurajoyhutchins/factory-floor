import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import type { Database } from '@factory-floor/db';
import type { Kysely } from 'kysely';
import type {
  OperatorContext,
  PageRequest,
  RunTopologyRequest,
} from './types.js';
import {
  RunScopedOperatorQueryService,
  runScopedCursorSemantics,
} from './run-scoped-operator-query-service.js';

/**
 * Public query surface rooted in a real command ID.
 *
 * The run-scoped implementation is retained only as an internal compatibility
 * adapter over existing persisted history. Correlation IDs remain grouping
 * metadata and are never accepted here as an authorization root.
 */
export class CommandScopedOperatorQueryService {
  private readonly legacy: RunScopedOperatorQueryService;

  constructor(db: Kysely<Database>, blobs?: ArtifactBlobStore) {
    this.legacy = new RunScopedOperatorQueryService(db, blobs);
  }

  getFactoryStatus(context: OperatorContext) {
    return this.legacy.getFactoryStatus(context);
  }

  async getCommandStatus(context: OperatorContext, commandId: string) {
    const result = await this.legacy.getRunStatus(context, commandId);
    const { runId, ...rest } = result;
    return { commandId: runId, ...rest };
  }

  async inspectCommandTrace(context: OperatorContext, commandId: string) {
    const result = await this.legacy.inspectRunTrace(context, commandId);
    const { run, ...rest } = result;
    return { command: run, ...rest };
  }

  async getCommandTopology(
    context: OperatorContext,
    commandId: string,
    options: RunTopologyRequest = {},
  ) {
    const result = await this.legacy.getRunTopology(context, commandId, options);
    const { run, ...rest } = result;
    return { command: run, ...rest };
  }

  listCommandAlerts(
    context: OperatorContext,
    commandId: string,
    page: PageRequest = {},
  ) {
    return this.legacy.listRunAlerts(context, commandId, page);
  }

  listCommandEvents(
    context: OperatorContext,
    commandId: string,
    page: PageRequest = {},
  ) {
    return this.legacy.listRunEvents(context, commandId, page);
  }

  listCommandArtifacts(
    context: OperatorContext,
    commandId: string,
    page: PageRequest = {},
  ) {
    return this.legacy.listRunArtifacts(context, commandId, page);
  }

  readCommandArtifact(
    context: OperatorContext,
    commandId: string,
    artifactId: string,
    maxBytes?: number,
  ) {
    return this.legacy.readRunArtifact(context, commandId, artifactId, maxBytes);
  }

  listPendingApprovals(context: OperatorContext, page: PageRequest = {}) {
    return this.legacy.listPendingApprovals(context, page);
  }
}

export const commandScopedCursorSemantics = runScopedCursorSemantics;