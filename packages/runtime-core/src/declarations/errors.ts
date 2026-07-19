export type DomainErrorCode =
  | 'invalid_declaration'
  | 'registration_conflict'
  | 'referenced_schema_not_found'
  | 'duplicate_port_identity'
  | 'duplicate_ingress_target'
  | 'duplicate_component_instance'
  | 'duplicate_region_identity'
  | 'duplicate_connection'
  | 'unsupported_declaration_version'
  | 'component_definition_not_found'
  | 'component_definition_retired'
  | 'component_not_allowed'
  | 'template_not_found'
  | 'template_retired'
  | 'invalid_template_parameters'
  | 'invalid_component_configuration'
  | 'artifact_schema_not_found'
  | 'artifact_schema_retired'
  | 'policy_not_found'
  | 'policy_retired'
  | 'capability_not_found'
  | 'capability_retired'
  | 'region_not_found'
  | 'region_not_eligible'
  | 'invalid_port_reference'
  | 'incompatible_port_schema'
  | 'missing_required_output'
  | 'invalid_fan_in_rule'
  | 'template_instantiation_conflict'
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

export const isDomainError = (error: unknown): error is DomainError =>
  error instanceof DomainError;
