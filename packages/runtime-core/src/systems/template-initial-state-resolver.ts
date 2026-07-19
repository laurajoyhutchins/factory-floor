/* eslint-disable @typescript-eslint/no-explicit-any */
import Ajv2020Module from 'ajv/dist/2020.js';
import type { Json, RuntimeDb } from '@factory-floor/db';
import { DefinitionRepository } from '@factory-floor/db';
import { DomainError } from '../declarations/errors.js';
import { validateSimpleDeclaration } from '../declarations/validation.js';

const Ajv2020 = (Ajv2020Module as any).default ?? (Ajv2020Module as any);

type JsonObject = { [key: string]: Json };

export interface ResolveTemplateInitialStateRequest {
  template: string;
  parameters?: JsonObject;
}

export interface ResolvedTemplateInitialState {
  componentInstanceName: string;
  portName: string;
  schemaId: string;
  schemaDigest: string;
  value: Json;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError(
      'invalid_declaration',
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function parseRef(reference: string): { name: string; version: string } {
  const separator = reference.lastIndexOf('@');
  if (separator < 1 || separator === reference.length - 1) {
    throw new DomainError(
      'invalid_declaration',
      `Invalid name@version reference ${reference}`,
    );
  }
  return {
    name: reference.slice(0, separator),
    version: reference.slice(separator + 1),
  };
}

function parameterValue(parameters: JsonObject, path: string): Json {
  const parts = path.startsWith('/')
    ? path
        .slice(1)
        .split('/')
        .filter(Boolean)
        .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    : path.split('.').filter(Boolean);
  let value: Json = parameters;
  for (const part of parts) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !(part in value)
    ) {
      throw new DomainError(
        'invalid_template_parameters',
        `Template parameter ${path} was not supplied`,
      );
    }
    value = value[part];
  }
  return value;
}

function bindParameters(value: Json, parameters: JsonObject): Json {
  if (Array.isArray(value)) {
    return value.map((item) => bindParameters(item, parameters));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (
      entries.length === 1 &&
      entries[0]?.[0] === '$parameter' &&
      typeof entries[0][1] === 'string'
    ) {
      return structuredClone(parameterValue(parameters, entries[0][1]));
    }
    return Object.fromEntries(
      entries.map(([key, item]) => [key, bindParameters(item, parameters)]),
    );
  }
  return value;
}

function initialStateDeclaration(instance: any): { port: string; value: Json } | undefined {
  const declaration = instance.initialState;
  if (declaration === undefined) return undefined;
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new DomainError(
      'invalid_declaration',
      `Initial state for ${instance.name} must be an object`,
    );
  }
  const port = requireNonEmptyString(
    declaration.port,
    `Initial state port for ${instance.name}`,
  );
  if (!Object.prototype.hasOwnProperty.call(declaration, 'value')) {
    throw new DomainError(
      'invalid_declaration',
      `Initial state for ${instance.name} requires value`,
    );
  }
  return { port, value: declaration.value as Json };
}

export class TemplateInitialStateResolver {
  constructor(private readonly definitions = new DefinitionRepository()) {}

  async resolve(
    db: RuntimeDb,
    request: ResolveTemplateInitialStateRequest,
  ): Promise<ResolvedTemplateInitialState[]> {
    const templateReference = parseRef(
      requireNonEmptyString(request.template, 'template'),
    );
    const template = await this.definitions.findTemplate(
      db,
      templateReference.name,
      templateReference.version,
    );
    if (template === undefined) {
      throw new DomainError(
        'template_not_found',
        `Template ${request.template} was not found`,
      );
    }
    if (template.retired_at !== null) {
      throw new DomainError(
        'template_retired',
        `Template ${request.template} is retired`,
      );
    }

    const document = structuredClone(template.template) as any;
    validateSimpleDeclaration(document, 'Template');
    const instances = document.spec?.initialTopology?.instances;
    if (!Array.isArray(instances)) return [];
    const parameters = structuredClone(request.parameters ?? {}) as JsonObject;
    const resolved: ResolvedTemplateInitialState[] = [];

    for (const instance of instances) {
      const declaration = initialStateDeclaration(instance);
      if (declaration === undefined) continue;
      const instanceName = requireNonEmptyString(
        instance.name,
        'Initial state component instance name',
      );
      const componentReference = parseRef(
        requireNonEmptyString(
          instance.component,
          `Component reference for ${instanceName}`,
        ),
      );
      const component = await this.definitions.findComponentDefinition(
        db,
        componentReference.name,
        componentReference.version,
      );
      if (component === undefined) {
        throw new DomainError(
          'component_definition_not_found',
          `Component definition ${instance.component} was not found`,
        );
      }
      if (component.retired_at !== null) {
        throw new DomainError(
          'component_definition_retired',
          `Component definition ${instance.component} is retired`,
        );
      }
      const statePort = (
        await this.definitions.listPorts(db, component.id)
      ).find(
        (port) =>
          port.direction === 'state' && port.name === declaration.port,
      );
      if (statePort === undefined) {
        throw new DomainError(
          'invalid_port_reference',
          `Initial state target ${instanceName}.${declaration.port} is not a declared state port`,
        );
      }
      const schema = await this.definitions.findArtifactSchemaById(
        db,
        statePort.schema_id,
      );
      if (schema === undefined) {
        throw new DomainError(
          'artifact_schema_not_found',
          `Artifact schema ${statePort.schema_id} for ${instanceName}.${declaration.port} was not found`,
        );
      }
      if (schema.retired_at !== null) {
        throw new DomainError(
          'artifact_schema_retired',
          `Artifact schema ${schema.name}@${schema.version} is retired`,
        );
      }

      const value = bindParameters(declaration.value, parameters);
      try {
        const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
          schema.schema,
        );
        if (!validate(value)) {
          throw new DomainError(
            'invalid_declaration',
            `Initial state for ${instanceName}.${declaration.port} does not satisfy ${schema.name}@${schema.version}: ${JSON.stringify(validate.errors ?? [])}`,
          );
        }
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError(
          'invalid_declaration',
          `Invalid state schema ${schema.name}@${schema.version}: ${(error as Error).message}`,
        );
      }

      resolved.push({
        componentInstanceName: instanceName,
        portName: declaration.port,
        schemaId: schema.id,
        schemaDigest: schema.content_digest,
        value: structuredClone(value),
      });
    }

    return resolved;
  }
}
