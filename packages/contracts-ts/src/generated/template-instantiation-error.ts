/** Generated from JSON Schema. Do not edit by hand. */

/**
 * Stable error envelope returned by the authoritative template-instantiation boundary.
 */
export interface TemplateInstantiationError {
  protocolVersion: '1.0';
  code:
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
  message: string;
  retryable: boolean;
}
