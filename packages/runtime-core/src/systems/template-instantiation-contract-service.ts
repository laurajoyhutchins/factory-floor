import type { TemplateInstantiationRequest as ContractTemplateInstantiationRequest } from '@factory-floor/contracts-ts';
import type {
  TemplateInstantiationRequest as InternalTemplateInstantiationRequest,
  TemplateInstantiationResult as InternalTemplateInstantiationResult,
} from './template-instantiation-service.js';
import {
  normalizeTemplateInstantiationRequest,
  toTemplateInstantiationResult,
  type TemplateInstantiationResult,
} from './template-instantiation-contract.js';

export interface TemplateInstantiationRuntime {
  instantiate(
    request: InternalTemplateInstantiationRequest,
  ): Promise<InternalTemplateInstantiationResult>;
}

function rowWithId(value: unknown, label: string): { id: string } {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== 'string'
  ) {
    throw new TypeError(`${label} must expose a string id`);
  }
  return value as { id: string };
}

/**
 * Language-neutral adapter around the authoritative topology publication service.
 * Canonical request validation completes before the wrapped runtime can perform
 * its first database lookup.
 */
export class TemplateInstantiationContractService {
  constructor(private readonly runtime: TemplateInstantiationRuntime) {}

  async instantiate(
    request: ContractTemplateInstantiationRequest,
  ): Promise<TemplateInstantiationResult> {
    const normalized = normalizeTemplateInstantiationRequest(request);
    const result = await this.runtime.instantiate({
      targetRegionId: normalized.targetRegionId,
      template: normalized.template,
      parameters: normalized.parameters,
      componentConfiguration: normalized.componentConfiguration,
      source: normalized.source,
    });
    return toTemplateInstantiationResult({
      request: normalized,
      disposition: result.disposition,
      digest: result.digest,
      region: rowWithId(result.region, 'template instantiation region'),
      revision: rowWithId(result.revision, 'template instantiation revision'),
      template: result.template,
      parameters: result.parameters,
      source: normalized.source,
      referencedDefinitions: result.referencedDefinitions,
    });
  }
}
