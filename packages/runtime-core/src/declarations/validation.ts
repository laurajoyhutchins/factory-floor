/* eslint-disable @typescript-eslint/no-explicit-any */
import Ajv2020Module from 'ajv/dist/2020.js';
import { DomainError } from './errors.js';

const Ajv2020 = (Ajv2020Module as any).default ?? (Ajv2020Module as any);
const apiVersion = 'factory-floor.dev/v1alpha1';
const legacyApiVersion = 'factoryfloor.dev/v1alpha1';

export type RegKind =
  'ArtifactSchema' | 'ComponentDefinition' | 'Template' | 'Policy';

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireReference(value: unknown, label: string): string {
  if (!nonEmptyString(value) || !/^[^@]+@[^@]+$/.test(value)) {
    throw new DomainError(
      'invalid_declaration',
      `${label} must be a name@version reference`,
    );
  }
  return value;
}

function requireEndpoint(value: unknown, label: string): string {
  if (!nonEmptyString(value) || !/^[^.]+\.[^.]+$/.test(value)) {
    throw new DomainError(
      'invalid_declaration',
      `${label} must be an instance.port endpoint`,
    );
  }
  return value;
}

export function requireEnvelope(doc: any, kind?: string): void {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new DomainError(
      'invalid_declaration',
      'Declaration must be an object',
    );
  }
  if (![apiVersion, legacyApiVersion].includes(doc.apiVersion)) {
    throw new DomainError(
      'unsupported_declaration_version',
      'Unsupported apiVersion',
    );
  }
  if (kind && doc.kind !== kind)
    throw new DomainError('invalid_declaration', `Expected kind ${kind}`);
  if (
    !nonEmptyString(doc.metadata?.name) ||
    !nonEmptyString(doc.metadata?.version)
  ) {
    throw new DomainError(
      'invalid_declaration',
      'metadata.name and metadata.version must be non-empty strings',
    );
  }
}

export function validateArtifactSchemaDeclaration(doc: any): void {
  requireEnvelope(doc, 'ArtifactSchema');
  const schema = doc.spec?.schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new DomainError('invalid_declaration', 'spec.schema is required');
  }
  schema.$schema ??= 'https://json-schema.org/draft/2020-12/schema';
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    throw new DomainError(
      'invalid_declaration',
      'Artifact schemas must use JSON Schema Draft 2020-12',
    );
  }
  try {
    new Ajv2020({ strict: true }).compile(schema);
  } catch (error) {
    throw new DomainError(
      'invalid_declaration',
      `Invalid JSON Schema: ${(error as Error).message}`,
    );
  }
}

export function validateComponentDefinitionDeclaration(doc: any): void {
  requireEnvelope(doc, 'ComponentDefinition');
  if (!Array.isArray(doc.spec?.ports))
    throw new DomainError('invalid_declaration', 'spec.ports is required');

  const seen = new Set<string>();
  for (const port of doc.spec.ports) {
    if (
      !nonEmptyString(port?.name) ||
      !['input', 'output', 'state'].includes(port.direction) ||
      typeof port.required !== 'boolean'
    ) {
      throw new DomainError(
        'invalid_declaration',
        'Each port requires name, direction, required',
      );
    }
    const reference = port.schema ?? port.schemaRef;
    if (
      !nonEmptyString(reference?.name) ||
      !nonEmptyString(reference?.version)
    ) {
      throw new DomainError(
        'invalid_declaration',
        'Each port requires schema natural key',
      );
    }
    const key = `${port.name}:${port.direction}`;
    if (seen.has(key))
      throw new DomainError('duplicate_port_identity', `Duplicate port ${key}`);
    seen.add(key);
  }
}

export function validateStaticTopology(topology: any): void {
  if (!topology || typeof topology !== 'object' || Array.isArray(topology)) {
    throw new DomainError(
      'invalid_declaration',
      'initialTopology must be an object',
    );
  }
  if (
    !Array.isArray(topology.instances) ||
    !Array.isArray(topology.connections)
  ) {
    throw new DomainError(
      'invalid_declaration',
      'initialTopology requires instances and connections arrays',
    );
  }

  const names = new Set<string>();
  for (const instance of topology.instances) {
    if (!nonEmptyString(instance?.name)) {
      throw new DomainError(
        'invalid_declaration',
        'Each topology instance requires a non-empty name',
      );
    }
    requireReference(
      instance.component,
      `Component reference for ${instance.name}`,
    );
    if (names.has(instance.name)) {
      throw new DomainError(
        'duplicate_component_instance',
        `Duplicate component instance ${instance.name}`,
      );
    }
    names.add(instance.name);
    if (
      instance.configuration !== undefined &&
      (!instance.configuration ||
        typeof instance.configuration !== 'object' ||
        Array.isArray(instance.configuration))
    ) {
      throw new DomainError(
        'invalid_declaration',
        `Configuration for ${instance.name} must be an object`,
      );
    }
  }

  const ingressCommands = topology.ingress?.commands;
  if (ingressCommands !== undefined) {
    if (
      !ingressCommands ||
      typeof ingressCommands !== 'object' ||
      Array.isArray(ingressCommands)
    )
      throw new DomainError(
        'invalid_declaration',
        'ingress.commands must be an object',
      );
    for (const [commandType, rule] of Object.entries(ingressCommands)) {
      if (!nonEmptyString(commandType))
        throw new DomainError(
          'invalid_declaration',
          'Ingress command type must be non-empty',
        );
      const targets = (rule as any)?.targets;
      if (!Array.isArray(targets))
        throw new DomainError(
          'invalid_declaration',
          `Ingress ${commandType} requires targets`,
        );
      const seenTargets = new Set<string>();
      for (const target of targets) {
        if (
          !nonEmptyString((target as any)?.component) ||
          !nonEmptyString((target as any)?.port)
        )
          throw new DomainError(
            'invalid_declaration',
            `Ingress ${commandType} target requires component and port`,
          );
        if (!names.has((target as any).component))
          throw new DomainError(
            'invalid_declaration',
            `Ingress ${commandType} target component does not exist`,
          );
        const key = `${(target as any).component}.${(target as any).port}`;
        if (seenTargets.has(key))
          throw new DomainError(
            'duplicate_ingress_target',
            `Duplicate ingress target ${key}`,
          );
        seenTargets.add(key);
      }
      (rule as any).targets = [...targets].sort(
        (a: any, b: any) =>
          a.component.localeCompare(b.component) ||
          a.port.localeCompare(b.port),
      );
    }
  }

  for (const connection of topology.connections) {
    requireEndpoint(connection?.from, 'Connection source');
    requireEndpoint(connection?.to, 'Connection target');
  }
}

export function validateSimpleDeclaration(
  doc: any,
  kind: 'Template' | 'Policy',
): void {
  requireEnvelope(doc, kind);
  if (!doc.spec || typeof doc.spec !== 'object' || Array.isArray(doc.spec)) {
    throw new DomainError('invalid_declaration', 'spec is required');
  }
  if (kind === 'Template' && doc.spec.initialTopology !== undefined) {
    validateStaticTopology(doc.spec.initialTopology);
  }
}

export function validateSystemDeclaration(doc: any): void {
  requireEnvelope(doc, 'System');
  const spec = doc.spec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new DomainError('invalid_declaration', 'spec is required');
  }
  if (!nonEmptyString(spec.rootRegion?.id)) {
    throw new DomainError(
      'invalid_declaration',
      'spec.rootRegion.id is required',
    );
  }
  if (!Array.isArray(spec.regions) || spec.regions.length === 0) {
    throw new DomainError(
      'invalid_declaration',
      'spec.regions must contain at least one stable region',
    );
  }

  const regionIds = new Set<string>();
  for (const region of spec.regions) {
    if (!nonEmptyString(region?.id))
      throw new DomainError(
        'invalid_declaration',
        'Each region requires an id',
      );
    requireReference(
      region.template,
      `Template reference for region ${region.id}`,
    );
    if (regionIds.has(region.id))
      throw new DomainError(
        'duplicate_region_identity',
        `Duplicate region ${region.id}`,
      );
    regionIds.add(region.id);
  }

  if (spec.connections !== undefined) {
    if (!Array.isArray(spec.connections))
      throw new DomainError(
        'invalid_declaration',
        'spec.connections must be an array',
      );
    for (const connection of spec.connections) {
      requireEndpoint(connection?.from, 'Region connection source');
      requireEndpoint(connection?.to, 'Region connection target');
    }
  }
}
