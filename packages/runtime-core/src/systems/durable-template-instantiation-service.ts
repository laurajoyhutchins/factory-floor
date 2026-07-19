import type { Kysely } from 'kysely';
import type { Database, Json, RuntimeDb } from '@factory-floor/db';
import {
  DefinitionRepository,
  isUniqueViolation,
  TemplateInstantiationRepository,
  TopologyRepository,
} from '@factory-floor/db';
import { canonicalJsonDigest } from '../declarations/canonical-json.js';
import { DomainError } from '../declarations/errors.js';
import {
  TemplateInstantiationService as TopologyTemplateInstantiationService,
  type TemplateInstantiationRequest as TopologyTemplateInstantiationRequest,
  type TemplateInstantiationResult as TopologyTemplateInstantiationResult,
} from './template-instantiation-service.js';

type JsonObject = { [key: string]: Json };

export interface TemplateInstantiationRequest
  extends TopologyTemplateInstantiationRequest {
  requestId?: string;
}

export interface TemplateInstantiationResult
  extends TopologyTemplateInstantiationResult {
  instantiationId: string;
}

function deterministicRequestId(requestDigest: string): string {
  const hex = requestDigest.slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function validateRequestId(requestId: string | undefined): void {
  if (requestId === undefined) return;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requestId,
    )
  ) {
    throw new DomainError('invalid_declaration', 'requestId must be a UUID');
  }
}

function rowId(value: unknown, label: string): string {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== 'string'
  ) {
    throw new TypeError(`${label} must expose a string id`);
  }
  return (value as { id: string }).id;
}

export class TemplateInstantiationService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly definitions = new DefinitionRepository(),
    private readonly topology = new TopologyRepository(),
    private readonly instantiations = new TemplateInstantiationRepository(),
    private readonly topologyService = new TopologyTemplateInstantiationService(
      db,
      definitions,
      topology,
    ),
  ) {}

  async instantiate(
    request: TemplateInstantiationRequest,
  ): Promise<TemplateInstantiationResult> {
    validateRequestId(request.requestId);
    try {
      return await this.db
        .transaction()
        .execute((transaction) =>
          this.instantiateInTransaction(transaction, request),
        );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.db
        .transaction()
        .execute((transaction) =>
          this.instantiateInTransaction(transaction, request),
        );
    }
  }

  async instantiateInTransaction(
    transaction: RuntimeDb,
    request: TemplateInstantiationRequest,
  ): Promise<TemplateInstantiationResult> {
    validateRequestId(request.requestId);
    const parameters = structuredClone(request.parameters ?? {}) as JsonObject;
    const componentConfiguration = structuredClone(
      request.componentConfiguration ?? {},
    ) as Record<string, JsonObject>;
    const source = structuredClone(request.source ?? {}) as JsonObject;
    const requestDigest = canonicalJsonDigest({
      targetRegionId: request.targetRegionId,
      template: request.template,
      parameters,
      componentConfiguration,
      source,
    });
    const requestId = request.requestId ?? deterministicRequestId(requestDigest);
    const existing = await this.instantiations.findByRequestId(
      transaction,
      requestId,
    );
    if (existing !== undefined && existing.request_digest !== requestDigest) {
      throw new DomainError(
        'template_instantiation_conflict',
        `Template instantiation request ${requestId} was already used for different content`,
      );
    }

    const topologyResult = await this.topologyService.instantiateInTransaction(
      transaction,
      {
        targetRegionId: request.targetRegionId,
        template: request.template,
        parameters,
        componentConfiguration,
        source,
      },
    );
    const regionId = rowId(topologyResult.region, 'template instantiation region');
    const topologyRevisionId = rowId(
      topologyResult.revision,
      'template instantiation revision',
    );

    if (existing !== undefined) {
      if (
        existing.target_region_id !== regionId ||
        existing.topology_revision_id !== topologyRevisionId ||
        existing.template_id !== topologyResult.template.id ||
        existing.effective_digest !== topologyResult.digest
      ) {
        throw new DomainError(
          'template_instantiation_conflict',
          `Template instantiation request ${requestId} no longer resolves to its recorded outcome`,
        );
      }
      return {
        ...topologyResult,
        disposition: 'existing',
        instantiationId: existing.id,
      };
    }

    const instantiation = await this.instantiations.create(transaction, {
      requestId,
      requestDigest,
      targetRegionId: regionId,
      topologyRevisionId,
      templateId: topologyResult.template.id,
      effectiveDigest: topologyResult.digest,
      parameters,
      componentConfiguration,
      source,
      referencedDefinitions: structuredClone(
        topologyResult.referencedDefinitions,
      ) as Json,
      initialDisposition: topologyResult.disposition,
    });

    return {
      ...topologyResult,
      instantiationId: instantiation.id,
    };
  }
}
