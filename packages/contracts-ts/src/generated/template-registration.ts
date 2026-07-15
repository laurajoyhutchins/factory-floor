/** Generated from JSON Schema. Do not edit by hand. */

export interface TemplateRegistration {
  apiVersion: 'factory-floor.dev/v1alpha1';
  kind: 'Template';
  metadata: {
    name: string;
    version: string;
  };
  spec: {
    [k: string]: unknown;
  };
}
