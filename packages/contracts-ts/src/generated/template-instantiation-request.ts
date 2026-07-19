/** Generated from JSON Schema. Do not edit by hand. */

/**
 * This interface was referenced by `TemplateInstantiationRequest`'s JSON-Schema
 * via the `definition` "sha256Digest".
 */
export type Sha256Digest = string;
/**
 * This interface was referenced by `TemplateInstantiationRequest`'s JSON-Schema
 * via the `definition` "source".
 */
export type Source = SystemSource | RegionRequestSource | InternalSource;

/**
 * Versioned authoritative request to instantiate one registered template into an eligible target region.
 */
export interface TemplateInstantiationRequest {
  protocolVersion: '1.0';
  requestId: string;
  targetRegionId: string;
  template: NaturalKey;
  parameters?: {
    [k: string]: unknown;
  };
  componentConfiguration?: {
    [k: string]: {
      [k: string]: unknown;
    };
  };
  source: Source;
}
/**
 * This interface was referenced by `TemplateInstantiationRequest`'s JSON-Schema
 * via the `definition` "naturalKey".
 */
export interface NaturalKey {
  name: string;
  version: string;
}
/**
 * This interface was referenced by `TemplateInstantiationRequest`'s JSON-Schema
 * via the `definition` "systemSource".
 */
export interface SystemSource {
  kind: 'system';
  name: string;
  version: string;
  contentDigest: Sha256Digest;
}
/**
 * This interface was referenced by `TemplateInstantiationRequest`'s JSON-Schema
 * via the `definition` "regionRequestSource".
 */
export interface RegionRequestSource {
  kind: 'regionRequest';
  requestId: string;
  parentRegionId: string;
  requesterComponentInstanceId: string;
}
/**
 * This interface was referenced by `TemplateInstantiationRequest`'s JSON-Schema
 * via the `definition` "internalSource".
 */
export interface InternalSource {
  kind: 'internal';
  operation: string;
}
