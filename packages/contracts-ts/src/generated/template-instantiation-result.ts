/** Generated from JSON Schema. Do not edit by hand. */

/**
 * This interface was referenced by `TemplateInstantiationResult`'s JSON-Schema
 * via the `definition` "sha256Digest".
 */
export type Sha256Digest = string;
/**
 * This interface was referenced by `TemplateInstantiationResult`'s JSON-Schema
 * via the `definition` "source".
 */
export type Source = SystemSource | RegionRequestSource | InternalSource;

/**
 * Canonical result of authoritative template instantiation.
 */
export interface TemplateInstantiationResult {
  protocolVersion: '1.0';
  requestId: string;
  /**
   * Stable durable identity of the authoritative instantiation record.
   */
  instantiationId: string;
  disposition: 'created' | 'existing';
  digest: Sha256Digest;
  regionId: string;
  topologyRevisionId: string;
  template: ResolvedTemplate;
  parameters: {
    [k: string]: unknown;
  };
  source: Source;
  /**
   * @minItems 1
   */
  referencedDefinitions: [ResolvedReference, ...ResolvedReference[]];
}
/**
 * This interface was referenced by `TemplateInstantiationResult`'s JSON-Schema
 * via the `definition` "resolvedTemplate".
 */
export interface ResolvedTemplate {
  id: string;
  name: string;
  version: string;
  contentDigest: Sha256Digest;
}
/**
 * This interface was referenced by `TemplateInstantiationResult`'s JSON-Schema
 * via the `definition` "systemSource".
 */
export interface SystemSource {
  kind: 'system';
  name: string;
  version: string;
  contentDigest: Sha256Digest;
}
/**
 * This interface was referenced by `TemplateInstantiationResult`'s JSON-Schema
 * via the `definition` "regionRequestSource".
 */
export interface RegionRequestSource {
  kind: 'regionRequest';
  requestId: string;
  parentRegionId: string;
  requesterComponentInstanceId: string;
}
/**
 * This interface was referenced by `TemplateInstantiationResult`'s JSON-Schema
 * via the `definition` "internalSource".
 */
export interface InternalSource {
  kind: 'internal';
  operation: string;
}
/**
 * This interface was referenced by `TemplateInstantiationResult`'s JSON-Schema
 * via the `definition` "resolvedReference".
 */
export interface ResolvedReference {
  kind: 'template' | 'component' | 'schema' | 'policy' | 'capability';
  id: string;
  name: string;
  version: string;
  contentDigest: Sha256Digest;
}
