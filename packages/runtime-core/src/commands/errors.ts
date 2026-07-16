export class CommandConflictError extends Error {
  readonly code = 'idempotency_conflict' as const;
}
export class CommandRejectedError extends Error {
  readonly code = 'command_rejected' as const;
  constructor(public readonly rejection: unknown) {
    super('Command rejected');
  }
}
