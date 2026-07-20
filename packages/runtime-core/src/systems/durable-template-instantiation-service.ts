import type { Kysely } from 'kysely';
import type { Database, Json, RuntimeDb } from '@factory-floor/db';
import {
  ArtifactRepository,
  ComponentStateRepository,
  DefinitionRepository,
  isUniqueViolation,
  TemplateInstantiationRepository,
  TopologyRepository,
} from '@factory-floor/db';
import {
  canonicalizeJson,
  canonicalJsonDigest,
} from '../declarations/canonical-json.js';
import { DomainError } from '../declarations/errors.js';
import {
  TemplateInitialStateResolver,
  type ResolvedTemplateInitialState,
} from './template-initial-state-resolver.js';
import {
  TemplateInstantiationService as TopologyTemplateInstantiationService,
  type TemplateInstantiationRequest as TopologyTemplateInstantiationRequest,
  type TemplateInstantiationResult as TopologyTemplateInstantiationResult,
} from './template-instantiation-service.js';

type JsonObject = { [key: string]: Json };

export interface TemplateInstantiationRequest extends TopologyTemplateInstantiationRequest {
  requestId?: string;
}

export interface TemplateInstantiationResult extends TopologyTemplateInstantiationResult {
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

function assertArtifactIdentity(
  artifact: {
    schema_id: string;
    media_type: string;
    size_bytes: string;
    state: string;
  },
  input: { schemaId: string; mediaType: string; sizeBytes: string },
): void {
  if (
    artifact.schema_id !== input.schemaId ||
    artifact.media_type !== input.mediaType ||
    artifact.size_bytes !== input.sizeBytes ||
    artifact.state !== 'committed'
  ) {
    throw new DomainError(
      'template_instantiation_conflict',
      'Initial-state artifact digest already exists with incompatible immutable metadata',
    );
  }
}

export class TemplateInstantiationService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly definitions = new DefinitionRepository(),
    private readonly topology = new TopologyRepository(),
    private readonly instantiations = new TemplateInstantiationRepository(),
    private readonly artifacts = new ArtifactRepository(),
    private readonly states = new ComponentStateRepository(),
    private readonly initialStateResolver = new TemplateInitialStateResolver(
      definitions,
    ),
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
    const requestId =
      request.requestId ?? deterministicRequestId(requestDigest);
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

    const resolvedInitialStates = await this.initialStateResolver.resolve(
      transaction,
      {
        template: request.template,
        parameters,
      },
    );
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
    const regionId = rowId(
      topologyResult.region,
      'template instantiation region',
    );
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
      await this.publishInitialStates(transaction, {
        instantiationId: existing.id,
        regionId,
        topologyRevisionId,
        templateId: topologyResult.template.id,
        initialStates: resolvedInitialStates,
      });
      return {
        ...topologyResult,
        disposition: 'existing',
        instantiationId: existing.id,
      };
    }

    const referencedDefinitions: Json =
      topologyResult.referencedDefinitions.map((reference) => ({
        kind: reference.kind,
        id: reference.id,
        name: reference.name,
        version: reference.version,
        contentDigest: reference.contentDigest,
      }));
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
      referencedDefinitions,
      initialDisposition: topologyResult.disposition,
    });
    await this.publishInitialStates(transaction, {
      instantiationId: instantiation.id,
      regionId,
      topologyRevisionId,
      templateId: topologyResult.template.id,
      initialStates: resolvedInitialStates,
    });

    return {
      ...topologyResult,
      instantiationId: instantiation.id,
    };
  }

  private async publishInitialStates(
    transaction: RuntimeDb,
    input: {
      instantiationId: string;
      regionId: string;
      topologyRevisionId: string;
      templateId: string;
      initialStates: ResolvedTemplateInitialState[];
    },
  ): Promise<void> {
    if (input.initialStates.length === 0) return;
    const instanceRows = await transaction
      .selectFrom('component_instances')
      .select(['id', 'name'])
      .where('topology_revision_id', '=', input.topologyRevisionId)
      .execute();
    const instanceIds = new Map(instanceRows.map((row) => [row.name, row.id]));

    for (const state of input.initialStates) {
      const componentInstanceId = instanceIds.get(state.componentInstanceName);
      if (componentInstanceId === undefined) {
        throw new DomainError(
          'template_instantiation_conflict',
          `Initial-state owner ${state.componentInstanceName} was not published in topology ${input.topologyRevisionId}`,
        );
      }
      const canonical = canonicalizeJson(state.value);
      const digest = canonicalJsonDigest(state.value);
      const sizeBytes = Buffer.byteLength(canonical, 'utf8').toString();
      const provenance: Json = {
        kind: 'templateInstantiation',
        instantiationId: input.instantiationId,
        templateId: input.templateId,
        regionId: input.regionId,
      };
      const artifactResult =
        await this.artifacts.createCommittedArtifactIdempotently(transaction, {
          digest,
          sizeBytes,
          schemaId: state.schemaId,
          mediaType: 'application/json',
          locator: `inline-json://${digest}`,
          provenance,
        });
      assertArtifactIdentity(artifactResult.artifact, {
        schemaId: state.schemaId,
        mediaType: 'application/json',
        sizeBytes,
      });
      const inlineResult = await this.states.createInlinePayloadIdempotently(
        transaction,
        {
          artifactId: artifactResult.artifact.id,
          payload: state.value,
          canonicalSizeBytes: sizeBytes,
        },
      );
      if (
        canonicalizeJson(inlineResult.payload.payload) !== canonical ||
        inlineResult.payload.canonical_size_bytes !== sizeBytes
      ) {
        throw new DomainError(
          'template_instantiation_conflict',
          `Initial-state artifact ${artifactResult.artifact.id} has conflicting inline content`,
        );
      }
      const versionResult = await this.states.createInitialVersionIdempotently(
        transaction,
        {
          componentInstanceId,
          statePortName: state.portName,
          artifactId: artifactResult.artifact.id,
          schemaId: state.schemaId,
          topologyRevisionId: input.topologyRevisionId,
          regionId: input.regionId,
          sourceTemplateId: input.templateId,
          originTemplateInstantiationId: input.instantiationId,
          provenance,
        },
      );
      const version = versionResult.version;
      if (
        version.artifact_id !== artifactResult.artifact.id ||
        version.schema_id !== state.schemaId ||
        version.topology_revision_id !== input.topologyRevisionId ||
        version.region_id !== input.regionId ||
        version.source_template_id !== input.templateId
      ) {
        throw new DomainError(
          'template_instantiation_conflict',
          `Initial state for ${state.componentInstanceName}.${state.portName} conflicts with its recorded version`,
        );
      }
      await this.states.linkInstantiationIdempotently(
        transaction,
        input.instantiationId,
        version.id,
      );
    }
  }
}
