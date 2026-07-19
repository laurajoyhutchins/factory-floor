import { isDomainError } from '../declarations/errors.js';

export type TemplateInstantiationErrorCode =
  | 'invalid_declaration'
  | 'unsupported_declaration_version'
  | 'duplicate_port_identity'
  | 'duplicate_ingress_target'
  | 'duplicate_component_instance'
  | 'duplicate_region_identity'
  | 'duplicate_connection'
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
  | 'internal_transient_failure';

export interface TemplateInstantiationError {
  protocolVersion: '1.0';
  code: TemplateInstantiationErrorCode;
  message: string;
  retryable: boolean;
}

const exposedCodes = new Set<TemplateInstantiationErrorCode>([
  'invalid_declaration',
  'unsupported_declaration_version',
  'duplicate_port_identity',
  'duplicate_ingress_target',
  'duplicate_component_instance',
  'duplicate_region_identity',
  'duplicate_connection',
  'component_definition_not_found',
  'component_definition_retired',
  'component_not_allowed',
  'template_not_found',
  'template_retired',
  'invalid_template_parameters',
  'invalid_component_configuration',
  'artifact_schema_not_found',
  'artifact_schema_retired',
  'policy_not_found',
  'policy_retired',
  'capability_not_found',
  'capability_retired',
  'region_not_found',
  'region_not_eligible',
  'invalid_port_reference',
  'incompatible_port_schema',
  'missing_required_output',
  'invalid_fan_in_rule',
  'template_instantiation_conflict',
]);

export function toTemplateInstantiationError(
  error: unknown,
): TemplateInstantiationError {
  if (
    isDomainError(error) &&
    exposedCodes.has(error.code as TemplateInstantiationErrorCode)
  ) {
    return {
      protocolVersion: '1.0',
      code: error.code as TemplateInstantiationErrorCode,
      message: error.message,
      retryable: false,
    };
  }
  return {
    protocolVersion: '1.0',
    code: 'internal_transient_failure',
    message: 'template instantiation failed',
    retryable: true,
  };
}
