import { createHash } from 'node:crypto';
import type {
  TemplateInstantiationRequest as ContractTemplateInstantiationRequest,
  TemplateInstantiationResult as ContractTemplateInstantiationResult,
} from '@factory-floor/contracts-ts';
import type { Json } from '@factory-floor/db';
import { canonicalJsonDigest } from '../declarations/canonical-json.js';
import { DomainError } from '../declarations/errors.js';

export type JsonObject = { [key: string]: Json };
export type TemplateInstantiationSource =
  ContractTemplateInstantiationRequest['source'];

export interface LegacyTemplateInstantiationRequest {
  targetRegionId: string;
  template: string;
  parameters?: JsonObject;
  componentConfiguration?: Record<string, JsonObject>;
  source?: TemplateInstantiationSource;
}

export type TemplateInstantiationRequest =
  | ContractTemplateInstantiationRequest
  | LegacyTemplateInstantiationRequest;

const normalizedRequestBrand = Symbol('normalizedTemplateInstantiationRequest');

export interface NormalizedTemplateInstantiationRequest {
  readonly [normalizedRequestBrand]: true;
  protocolVersion: '1.0';
  requestId: string;
  targetRegionId: string;
  template: string;
  expectedTemplateContentDigest?: string;
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

export type TemplateInstantiationResult = ContractTemplateInstantiationResult;

export interface TemplateInstantiationResultInput {
  request:
    | ContractTemplateInstantiationRequest
    | NormalizedTemplateInstantiationRequest;
  disposition: 'created' | 'existing';
  digest: string;
  region: { id: string };
  revision: { id: string };
  template: {
    id: string;
    name: string;
    version: string;
    contentDigest: string;
  };
  parameters: JsonObject;
  source: TemplateInstantiationSource;
  referencedDefinitions: ResolvedInstantiationReference[];
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[a-f0-9]{64}$/;

function invalid(message: string): never {
  throw new DomainError('invalid_declaration', message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function requireClosedObject(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): Record<string, unknown> {
  const object = requireObject(value, label);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) invalid(`${label}.${key} is not allowed`);
  }
  for (const key of requiredKeys) {
    if (!(key in object)) invalid(`${label}.${key} is required`);
  }
  return object;
}

function requireString(value: unknown, label: string, maxLength = 128): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    invalid(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function requireUuid(value: unknown, label: string): string {
  const text = requireString(value, label, 64);
  if (!uuidPattern.test(text)) invalid(`${label} must be a UUID`);
  return text;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireJson(value: unknown, label: string): Json {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${label} must contain finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => requireJson(item, `${label}[${index}]`));
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        requireJson(item, `${label}.${key}`),
      ]),
    );
  }
  invalid(`${label} must contain only JSON values`);
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  const object = requireObject(value, label);
  return requireJson(object, label) as JsonObject;
}

function requireComponentConfiguration(
  value: unknown,
  label: string,
): Record<string, JsonObject> {
  const object = requireObject(value, label);
  return Object.fromEntries(
    Object.entries(object).map(([name, configuration]) => [
      requireString(name, `${label} instance name`),
      requireJsonObject(configuration, `${label}.${name}`),
    ]),
  );
}

function requireNaturalKey(value: unknown): {
  name: string;
  version: string;
  expectedContentDigest?: string;
} {
  const object = requireClosedObject(
    value,
    'template',
    ['name', 'version', 'expectedContentDigest'],
    ['name', 'version'],
  );
  return {
    name: requireString(object.name, 'template.name'),
    version: requireString(object.version, 'template.version'),
    ...(object.expectedContentDigest === undefined
      ? {}
      : {
          expectedContentDigest: requireDigest(
            object.expectedContentDigest,
            'template.expectedContentDigest',
          ),
        }),
  };
}

function requireSource(value: unknown): TemplateInstantiationSource {
  const object = requireObject(value, 'source');
  const kind = requireString(object.kind, 'source.kind');
  if (kind === 'system') {
    const source = requireClosedObject(
      object,
      'source',
      ['kind', 'name', 'version', 'contentDigest'],
      ['kind', 'name', 'version', 'contentDigest'],
    );
    return {
      kind,
      name: requireString(source.name, 'source.name'),
      version: requireString(source.version, 'source.version'),
      contentDigest: requireDigest(source.contentDigest, 'source.contentDigest'),
    };
  }
  if (kind === 'regionRequest') {
    const source = requireClosedObject(
      object,
      'source',
      [
        'kind',
        'requestId',
        'parentRegionId',
        'requesterComponentInstanceId',
      ],
      [
        'kind',
        'requestId',
        'parentRegionId',
        'requesterComponentInstanceId',
      ],
    );
    return {
      kind,
      requestId: requireUuid(source.requestId, 'source.requestId'),
      parentRegionId: requireUuid(source.parentRegionId, 'source.parentRegionId'),
      requesterComponentInstanceId: requireUuid(
        source.requesterComponentInstanceId,
        'source.requesterComponentInstanceId',
      ),
    };
  }
  if (kind === 'internal') {
    const source = requireClosedObject(
      object,
      'source',
      ['kind', 'operation'],
      ['kind', 'operation'],
    );
    return {
      kind,
      operation: requireString(source.operation, 'source.operation'),
    };
  }
  invalid(`source.kind ${kind} is not supported`);
}

function requireTemplateReference(value: unknown): string {
  const reference = requireString(value, 'template', 257);
  const separator = reference.lastIndexOf('@');
  if (separator < 1 || separator === reference.length - 1) {
    invalid('template must be a name@version reference');
  }
  requireString(reference.slice(0, separator), 'template name');
  requireString(reference.slice(separator + 1), 'template version');
  return reference;
}

function deterministicUuid(value: unknown): string {
  const bytes = createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalJsonDigest(value))
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
  const request = requireClosedObject(
    value,
    'request',
    [
      'protocolVersion',
      'requestId',
      'targetRegionId',
      'template',
      'parameters',
      'componentConfiguration',
      'source',
    ],
    [
      'protocolVersion',
      'requestId',
      'targetRegionId',
      'template',
      'source',
    ],
  );
  if (request.protocolVersion !== '1.0') {
    invalid('request.protocolVersion must be 1.0');
  }
  const template = requireNaturalKey(request.template);
  return branded({
    protocolVersion: '1.0',
    requestId: requireUuid(request.requestId, 'request.requestId'),
    targetRegionId: requireUuid(
      request.targetRegionId,
      'request.targetRegionId',
    ),
    template: `${template.name}@${template.version}`,
    ...(template.expectedContentDigest === undefined
      ? {}
      : { expectedTemplateContentDigest: template.expectedContentDigest }),
    parameters:
      request.parameters === undefined
        ? {}
        : requireJsonObject(request.parameters, 'request.parameters'),
    componentConfiguration:
      request.componentConfiguration === undefined
        ? {}
        : requireComponentConfiguration(
            request.componentConfiguration,
            'request.componentConfiguration',
          ),
    source: requireSource(request.source),
  });
}

function normalizeLegacyRequest(
  value: LegacyTemplateInstantiationRequest,
): NormalizedTemplateInstantiationRequest {
  const request = requireClosedObject(
    value,
    'request',
    [
      'targetRegionId',
      'template',
      'parameters',
      'componentConfiguration',
      'source',
    ],
    ['targetRegionId', 'template'],
  );
  const targetRegionId = requireString(
    request.targetRegionId,
    'request.targetRegionId',
    256,
  );
  const template = requireTemplateReference(request.template);
  const parameters =
    request.parameters === undefined
      ? {}
      : requireJsonObject(request.parameters, 'request.parameters');
  const componentConfiguration =
    request.componentConfiguration === undefined
      ? {}
      : requireComponentConfiguration(
          request.componentConfiguration,
          'request.componentConfiguration',
        );
  const source =
    request.source === undefined
      ? ({
          kind: 'internal',
          operation: 'template-instantiation',
        } as const)
      : requireSource(request.source);
  const requestId = deterministicUuid({
    targetRegionId,
    template,
    parameters,
    componentConfiguration,
    source,
  });
  return branded({
    protocolVersion: '1.0',
    requestId,
    targetRegionId,
    template,
    parameters,
    componentConfiguration,
    source,
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
  const regionId = requireString(input.region.id, 'result.region.id', 256);
  const topologyRevisionId = requireString(
    input.revision.id,
    'result.revision.id',
    256,
  );
  return {
    protocolVersion: '1.0',
    requestId: request.requestId,
    disposition: input.disposition,
    digest: input.digest,
    regionId,
    topologyRevisionId,
    template: structuredClone(input.template),
    parameters: structuredClone(input.parameters),
    source: structuredClone(input.source),
    referencedDefinitions: structuredClone(input.referencedDefinitions) as [
      ResolvedInstantiationReference,
      ...ResolvedInstantiationReference[],
    ],
  };
}
