import type { Database } from '@factory-floor/db';
import type { Kysely } from 'kysely';
import { CommandService } from '../commands/command-service.js';
import { EventService } from '../events/event-service.js';
import { OperatorCommandService as LegacyOperatorCommandService } from './operator-command-service.js';
import type {
  ApprovalDecisionRequest,
  DevelopmentTaskRequest,
  OperatorContext,
  RunCancellationRequest,
} from './types.js';

/**
 * Public operator command surface keyed by durable command identity.
 *
 * The legacy implementation remains an internal persistence adapter while
 * stored command/correlation history is migrated. Synthetic run identity is
 * intentionally not exposed from this class.
 */
export class OperatorCommandService {
  private readonly legacy: LegacyOperatorCommandService;

  constructor(
    db: Kysely<Database>,
    commands?: CommandService,
    events?: EventService,
    clock?: () => Date,
  ) {
    this.legacy = new LegacyOperatorCommandService(db, commands, events, clock);
  }

  async submitDevelopmentTask(
    context: OperatorContext,
    input: DevelopmentTaskRequest,
  ) {
    const result = await this.legacy.submitDevelopmentTask(context, input);
    return {
      commandId: result.commandId,
      regionId: result.regionId,
      regionName: result.regionName,
      status: result.status,
      disposition: result.disposition,
      rejection: result.rejection,
    };
  }

  decideApproval(
    context: OperatorContext,
    approvalId: string,
    input: ApprovalDecisionRequest,
  ) {
    return this.legacy.decideApproval(context, approvalId, input);
  }

  async cancelCommand(
    context: OperatorContext,
    commandId: string,
    input: RunCancellationRequest,
  ) {
    const result = await this.legacy.cancelRun(context, commandId, input);
    const { runId, ...rest } = result;
    return { commandId: runId, ...rest };
  }
}