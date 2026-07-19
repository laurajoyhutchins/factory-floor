/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import Ajv2020Module from 'ajv/dist/2020.js';
import type { Json } from '@factory-floor/db';
import { canonicalJsonDigest } from '../declarations/canonical-json.js';
import { DomainError } from '../declarations/errors.js';

const Ajv2020 = (Ajv2020Module as any).default ?? (Ajv2020Module as any);
const uuidPattern =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

/**
 * Runtime copy of the canonical request schema. A focused test requires this
 * object to remain byte-for-byte equivalent as JSON to the source contract.
 */
export const templateInstantiationRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://factory-floor.local/contracts/template-instantiation-request.schema.json',
  title: 'TemplateInstantiationRequest',
  description:
    'Versioned authoritative request to instantiate one registered template into an eligible target region.',
  type: 'object',
  additionalProperties: false,
  $defs: {
    sha256Digest: {
      type: 'string',
      pattern: '^[a-f0-9]{64}$',
    },
    naturalKey: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 128 },
        version: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['name', 'version'],
    },
    systemSource: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'system' },
        name: { type: 'string', minLength: 1, maxLength: 128 },
        version: { type: 'string', minLength: 1, maxLength: 128 },
        contentDigest: { $ref: '#/$defs/sha256Digest' },
      },
      required: ['kind', 'name', 'version', 'contentDigest'],
    },
    regionRequestSource: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'regionRequest' },
        requestId: { type: 'string', format: 'uuid' },
        parentRegionId: { type: 'string', format: 'uuid' },
        requesterComponentInstanceId: { type: 'string', format: 'uuid' },
      },
      required: [
        'kind',
        'requestId',
        'parentRegionId',
        'requesterComponentInstanceId',
      ],
    },
    internalSource: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'internal' },
        operation: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['kind', 'operation'],
    },
    source: {
      oneOf: [
        { $ref: '#/$defs/systemSource' },
        { $ref: '#/$defs/regionRequestSource' },
        { $ref: '#/$defs/internalSource' },
      ],
    },
  },
  properties: {
    protocolVersion: { const: '1.0' },
    requestId: { type: 'string', format: 'uuid' },
    targetRegionId: { type: 'string', format: 'uuid' },
    template: { $ref: '#/$defs/naturalKey' },
    parameters: {
      type: 'object',
      additionalProperties: true,
      default: {},
    },
    componentConfiguration: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: true,
      },
      default: {},
    },
    source: { $ref: '#/$defs/source' },
  },
  required: [
    'protocolVersion',
    'requestId',
    'targetRegionId',
    'template',
    'source',
  ],
} as const;

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  formats: { uuid: new RegExp(uuidPattern) },
});
ajv.addSchema(templateInstantiationRequestSchema);
const validateCanonicalRequest = ajv.getSchema(
  templateInstantiationRequestSchema.$id,
)!;
const validateSource = ajv.compile({
  $ref: `${templateInstantiationRequestSchema.$id}#/$defs/source`,
});

export type JsonObject = { [key: string]: Json };

export type TemplateInstantiationSource =
  | {
      kind: 'system';
      name: string;
      version: string;
      contentDigest: string;
    }
  | {
      kind: 'regionRequest';
      requestId: string;
      parentRegionId: string;
      requesterComponentInstanceId: string;
    }
  | {
      kind: 'internal';
      operation: string;
    };

/** Structural twin of the generated TypeScript request binding. */
export interface CanonicalTemplateInstantiationRequest {
  protocolVersion: '1.0';
  requestId: string;
  targetRegionId: string;
  template: { name: string; version: string };
  parameters?: JsonObject;
  componentConfiguration?: Record<string, JsonObject>;
  source: TemplateInstantiationSource;
}

export interface LegacyTemplateInstantiationRequest {
  targetRegionId: string;
  template: string;
  parameters?: JsonObject;
  componentConfiguration?: Record<string, JsonObject>;
  source?: TemplateInstantiationSource;
}

export type TemplateInstantiationRequest =
  CanonicalTemplateInstantiationRequest | LegacyTemplateInstantiationRequest;

const normalizedRequestBrand = Symbol('normalizedTemplateInstantiationRequest');

export interface NormalizedTemplateInstantiationRequest {
  readonly [normalizedRequestBrand]: true;
  protocolVersion: '1.0';
  requestId: string;
  targetRegionId: string;
  template: string;
  parameters: JsonObject;
  componentConfiguration: Record<string, JsonObject>;
  source: TemplateInstantiationSource;
}

export interface ResolvedInstantiationReference {
  kind: 'template' | 'component' | 'schema' | 'policy' | 'capability';
  id: string;
  name: string;
  version: string;
  contentDigest: string;
}

/** Structural twin of the generated TypeScript result binding. */
export interface TemplateInstantiationResult {
  protocolVersion: '1.0';
  requestId: string;
  instantiationId: string;
  disposition: 'created' | 'existing';
  digest: string;
  regionId: string;
  topologyRevisionId: string;
  template: {
    id: string;
    name: string;
    version: string;
    contentDigest: string;
  };
  parameters: JsonObject;
  source: TemplateInstantiationSource;
  referencedDefinitions: [
    ResolvedInstantiationReference,
    ...ResolvedInstantiationReference[],
  ];
}

export interface TemplateInstantiationResultInput {
  request:
    | CanonicalTemplateInstantiationRequest
    | NormalizedTemplateInstantiationRequest;
  instantiationId: string;
  disposition: 'created' | 'existing';
  digest: string;
  region: { id: string };
  revision: { id: string };
  template: TemplateInstantiationResult['template'];
  parameters: JsonObject;
  source: TemplateInstantiationSource;
  referencedDefinitions: ResolvedInstantiationReference[];
}

function invalid(message: string): never {
  throw new DomainError('invalid_declaration', message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) invalid(`${label} must be an object`);
  try {
    canonicalJsonDigest(value);
  } catch (error) {
    invalid(
      `${label} must contain only JSON values: ${(error as Error).message}`,
    );
  }
  return structuredClone(value) as JsonObject;
}

function componentConfiguration(value: unknown): Record<string, JsonObject> {
  const object = jsonObject(value, 'componentConfiguration');
  return Object.fromEntries(
    Object.entries(object).map(([name, configuration]) => [
      name,
      jsonObject(configuration, `componentConfiguration.${name}`),
    ]),
  );
}

function source(value: unknown): TemplateInstantiationSource {
  if (!validateSource(value)) {
    invalid(
      `source does not satisfy the template-instantiation contract: ${JSON.stringify(validateSource.errors ?? [])}`,
    );
  }
  return structuredClone(value) as TemplateInstantiationSource;
}

function templateReference(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid('template must be a non-empty name@version reference');
  }
  const separator = value.lastIndexOf('@');
  if (separator < 1 || separator === value.length - 1) {
    invalid('template must be a name@version reference');
  }
  return value;
}

function deterministicUuid(value: unknown): string {
  const bytes = createHash('sha256')
    .update(canonicalJsonDigest(value))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function branded(
  value: Omit<
    NormalizedTemplateInstantiationRequest,
    typeof normalizedRequestBrand
  >,
): NormalizedTemplateInstantiationRequest {
  Object.defineProperty(value, normalizedRequestBrand, {
    value: true,
    enumerable: false,
  });
  return value as NormalizedTemplateInstantiationRequest;
}

function isNormalized(
  value: unknown,
): value is NormalizedTemplateInstantiationRequest {
  return (
    isObject(value) &&
    normalizedRequestBrand in value &&
    value[normalizedRequestBrand] === true
  );
}

function normalizeCanonicalRequest(
  value: unknown,
): NormalizedTemplateInstantiationRequest {
  if (!validateCanonicalRequest(value)) {
    invalid(
      `request does not satisfy the template-instantiation contract: ${JSON.stringify(validateCanonicalRequest.errors ?? [])}`,
    );
  }
  const request = structuredClone(
    value,
  ) as CanonicalTemplateInstantiationRequest;
  return branded({
    protocolVersion: '1.0',
    requestId: request.requestId,
    targetRegionId: request.targetRegionId,
    template: `${request.template.name}@${request.template.version}`,
    parameters: request.parameters ?? {},
    componentConfiguration: request.componentConfiguration ?? {},
    source: request.source,
  });
}

function normalizeLegacyRequest(
  value: LegacyTemplateInstantiationRequest,
): NormalizedTemplateInstantiationRequest {
  if (!isObject(value)) invalid('request must be an object');
  const allowed = new Set([
    'targetRegionId',
    'template',
    'parameters',
    'componentConfiguration',
    'source',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`request.${key} is not allowed`);
  }
  if (
    typeof value.targetRegionId !== 'string' ||
    value.targetRegionId.trim().length === 0
  ) {
    invalid('targetRegionId must be a non-empty string');
  }
  const normalizedSource =
    value.source === undefined
      ? ({
          kind: 'internal',
          operation: 'template-instantiation',
        } as const)
      : source(value.source);
  const parameters = jsonObject(value.parameters ?? {}, 'parameters');
  const normalizedConfiguration = componentConfiguration(
    value.componentConfiguration ?? {},
  );
  const template = templateReference(value.template);
  const requestId = deterministicUuid({
    targetRegionId: value.targetRegionId,
    template,
    parameters,
    componentConfiguration: normalizedConfiguration,
    source: normalizedSource,
  });
  return branded({
    protocolVersion: '1.0',
    requestId,
    targetRegionId: value.targetRegionId,
    template,
    parameters,
    componentConfiguration: normalizedConfiguration,
    source: normalizedSource,
  });
}

export function normalizeTemplateInstantiationRequest(
  value:
    | TemplateInstantiationRequest
    | NormalizedTemplateInstantiationRequest
    | unknown,
): NormalizedTemplateInstantiationRequest {
  if (isNormalized(value)) return value;
  if (isObject(value) && 'protocolVersion' in value) {
    return normalizeCanonicalRequest(value);
  }
  return normalizeLegacyRequest(value as LegacyTemplateInstantiationRequest);
}

export function toTemplateInstantiationResult(
  input: TemplateInstantiationResultInput,
): TemplateInstantiationResult {
  const request = normalizeTemplateInstantiationRequest(input.request);
  if (input.referencedDefinitions.length === 0) {
    invalid('referencedDefinitions must contain at least one reference');
  }
  return {
    protocolVersion: '1.0',
    requestId: request.requestId,
    instantiationId: input.instantiationId,
    disposition: input.disposition,
    digest: input.digest,
    regionId: input.region.id,
    topologyRevisionId: input.revision.id,
    template: structuredClone(input.template),
    parameters: structuredClone(input.parameters),
    source: structuredClone(input.source),
    referencedDefinitions: structuredClone(input.referencedDefinitions) as [
      ResolvedInstantiationReference,
      ...ResolvedInstantiationReference[],
    ],
  };
}
