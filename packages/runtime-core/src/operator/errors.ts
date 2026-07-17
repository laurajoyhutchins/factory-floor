export class OperatorAuthorizationError extends Error {
  constructor() {
    super('operator_forbidden');
    this.name = 'OperatorAuthorizationError';
  }
}

export class OperatorConflictError extends Error {
  constructor(message = 'operator_conflict') {
    super(message);
    this.name = 'OperatorConflictError';
  }
}

export class OperatorValidationError extends Error {
  constructor(message = 'operator_validation_error') {
    super(message);
    this.name = 'OperatorValidationError';
  }
}

export class OperatorNotFoundError extends Error {
  constructor(message = 'operator_not_found') {
    super(message);
    this.name = 'OperatorNotFoundError';
  }
}
