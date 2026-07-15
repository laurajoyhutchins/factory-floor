/** Generated from JSON Schema. Do not edit by hand. */

export interface PolicyRegistration {
  apiVersion: 'factory-floor.dev/v1alpha1';
  kind: 'Policy';
  metadata: {
    name: string;
    version: string;
  };
  spec: {
    [k: string]: unknown;
  };
}
