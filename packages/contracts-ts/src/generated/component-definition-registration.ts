/** Generated from JSON Schema. Do not edit by hand. */

export interface ComponentDefinitionRegistration {
  apiVersion: 'factory-floor.dev/v1alpha1';
  kind: 'ComponentDefinition';
  metadata: {
    name: string;
    version: string;
  };
  spec: {
    [k: string]: unknown;
  };
}
