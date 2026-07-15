export type DomainErrorCode =
  | 'invalid_declaration'
  | 'registration_conflict'
  | 'referenced_schema_not_found'
  | 'duplicate_port_identity'
  | 'duplicate_component_instance'
  | 'duplicate_region_identity'
  | 'unsupported_declaration_version'
  | 'component_definition_not_found'
  | 'template_not_found'
  | 'invalid_port_reference'
  | 'system_conflict';

export class DomainError extends Error {
  constructor(
    public code: DomainErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const isDomainError = (error: unknown): error is DomainError => error instanceof DomainError;
