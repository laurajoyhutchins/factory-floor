/* eslint-disable @typescript-eslint/no-explicit-any */
import Ajv2020Module from 'ajv/dist/2020.js';
import type { Kysely } from 'kysely';
import type { Database, Json, RuntimeDb } from '@factory-floor/db';
import {
  DefinitionRepository,
  isUniqueViolation,
  TopologyRepository,
} from '@factory-floor/db';
import { canonicalJsonDigest } from '../declarations/canonical-json.js';
import { DomainError } from '../declarations/errors.js';
import {
  validateSimpleDeclaration,
  validateStaticTopology,
} from '../declarations/validation.js';

const Ajv2020 = (Ajv2020Module as any).default ?? (Ajv2020Module as any);

type JsonObject = { [key: string]: Json };
type PortDirection = 'input' | 'output' | 'state';

export interface TemplateInstantiationRequest {
  targetRegionId: string;
  template: string;
  parameters?: JsonObject;
  componentConfiguration?: Record<string, JsonObject>;
}

export interface ResolvedInstantiationReference {
  kind: 'template' | 'component' | 'schema' | 'policy' | 'capability';
  id: string;
  name: string;
  version: string;
  contentDigest: string;
}

export interface TemplateInstantiationResult {
  disposition: 'created' | 'existing';
  digest: string;
  region: unknown;
  revision: unknown;
  template: {
    id: string;
    name: string;
    version: string;
    contentDigest: string;
  };
  parameters: JsonObject;
  referencedDefinitions: ResolvedInstantiationReference[];
}

interface ResolvedPort {
  direction: PortDirection;
  schemaId: string;
}

interface ResolvedInstance {
  name: string;
  component: string;
  definitionId: string;
  configuration: JsonObject;
  ports: Map<string, ResolvedPort>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError('invalid_declaration', `${label} must be a non-empty string`);
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

function parseSchemaRef(
  reference: unknown,
  label: string,
): { name: string; version: string } {
  if (
    reference &&
    typeof reference === 'object' &&
    !Array.isArray(reference)
  ) {
    return {
      name: requireNonEmptyString((reference as any).name, `${label}.name`),
      version: requireNonEmptyString(
        (reference as any).version,
        `${label}.version`,
      ),
    };
  }
  const value = requireNonEmptyString(reference, label);
  if (value.includes('@')) return parseRef(value);
  const separator = value.lastIndexOf('.');
  if (separator < 1 || separator === value.length - 1) {
    throw new DomainError(
      'invalid_declaration',
      `${label} must be name@version, name.version, or a natural-key object`,
    );
  }
  return {
    name: value.slice(0, separator),
    version: value.slice(separator + 1),
  };
}

function endpoint(value: string): { instance: string; port: string } {
  const separator = value.lastIndexOf('.');
  if (separator < 1 || separator === value.length - 1) {
    throw new DomainError('invalid_declaration', `Invalid endpoint ${value}`);
  }
  return {
    instance: value.slice(0, separator),
    port: value.slice(separator + 1),
  };
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('invalid_declaration', `${label} must be an object`);
  }
  return value as JsonObject;
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
    if (!value || typeof value !== 'object' || Array.isArray(value) || !(part in value)) {
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

function mergeObjects(base: JsonObject, override: JsonObject): JsonObject {
  const result: JsonObject = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (
      current &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      result[key] = mergeObjects(current, value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

function validateParameterSchema(schema: unknown, parameters: JsonObject): void {
  if (schema === undefined) {
    if (Object.keys(parameters).length > 0) {
      throw new DomainError(
        'invalid_template_parameters',
        'Template does not declare parameters',
      );
    }
    return;
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new DomainError(
      'invalid_declaration',
      'Template spec.parameters must be a JSON Schema object',
    );
  }
  try {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    if (!validate(parameters)) {
      throw new DomainError(
        'invalid_template_parameters',
        `Template parameters do not satisfy the declared schema: ${JSON.stringify(validate.errors ?? [])}`,
      );
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      'invalid_declaration',
      `Invalid template parameter schema: ${(error as Error).message}`,
    );
  }
}

function validateResourceDeclarations(spec: any): void {
  for (const sectionName of ['constraints', 'budgets', 'resources']) {
    const section = spec?.[sectionName];
    if (section === undefined) continue;
    const object = jsonObject(section, `Template spec.${sectionName}`);
    for (const [name, value] of Object.entries(object)) {
      if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
        throw new DomainError(
          'invalid_declaration',
          `Template spec.${sectionName}.${name} must be a finite non-negative number`,
        );
      }
    }
  }
}

function sortedReferences(
  references: Map<string, ResolvedInstantiationReference>,
): ResolvedInstantiationReference[] {
  return [...references.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version) ||
      left.id.localeCompare(right.id),
  );
}

export class TemplateInstantiationService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly definitions = new DefinitionRepository(),
    private readonly topology = new TopologyRepository(),
  ) {}

  async instantiate(
    request: TemplateInstantiationRequest,
  ): Promise<TemplateInstantiationResult> {
    this.validateRequest(request);
    try {
      return await this.db.transaction().execute((transaction) =>
        this.instantiateInTransaction(transaction, request),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.db.transaction().execute((transaction) =>
        this.instantiateInTransaction(transaction, request),
      );
    }
  }

  async instantiateInTransaction(
    transaction: RuntimeDb,
    request: TemplateInstantiationRequest,
  ): Promise<TemplateInstantiationResult> {
    this.validateRequest(request);
    const region = await this.topology.findRegion(
      transaction,
      request.targetRegionId,
    );
    if (region === undefined) {
      throw new DomainError(
        'region_not_found',
        `Target region ${request.targetRegionId} was not found`,
      );
    }

    const templateReference = parseRef(request.template);
    const templateRow = await this.definitions.findTemplate(
      transaction,
      templateReference.name,
      templateReference.version,
    );
    if (templateRow === undefined) {
      throw new DomainError(
        'template_not_found',
        `Template ${request.template} was not found`,
      );
    }
    if (templateRow.retired_at !== null) {
      throw new DomainError(
        'template_retired',
        `Template ${request.template} is retired`,
      );
    }

    const templateDocument = structuredClone(templateRow.template) as any;
    validateSimpleDeclaration(templateDocument, 'Template');
    const staticTopology = templateDocument.spec.initialTopology;
    if (staticTopology === undefined) {
      throw new DomainError(
        'invalid_declaration',
        `Template ${request.template} does not define spec.initialTopology`,
      );
    }
    validateStaticTopology(staticTopology);
    validateResourceDeclarations(templateDocument.spec);

    const parameters = structuredClone(request.parameters ?? {});
    validateParameterSchema(templateDocument.spec.parameters, parameters);
    const configurationOverrides = request.componentConfiguration ?? {};
    const instanceNames = new Set(
      staticTopology.instances.map((instance: any) => instance.name as string),
    );
    for (const [instanceName, configuration] of Object.entries(
      configurationOverrides,
    )) {
      if (!instanceNames.has(instanceName)) {
        throw new DomainError(
          'invalid_component_configuration',
          `Configuration override references unknown instance ${instanceName}`,
        );
      }
      jsonObject(configuration, `Configuration override for ${instanceName}`);
    }

    const references = new Map<string, ResolvedInstantiationReference>();
    const addReference = (reference: ResolvedInstantiationReference) => {
      references.set(`${reference.kind}:${reference.id}`, reference);
    };
    addReference({
      kind: 'template',
      id: templateRow.id,
      name: templateRow.name,
      version: templateRow.version,
      contentDigest: templateRow.content_digest,
    });

    const resolvedInstances = new Map<string, ResolvedInstance>();
    const allowedComponents = Array.isArray(templateDocument.spec.allowedComponents)
      ? new Set(templateDocument.spec.allowedComponents.map(String))
      : undefined;
    for (const instance of staticTopology.instances) {
      if (allowedComponents && !allowedComponents.has(instance.component)) {
        throw new DomainError(
          'component_not_allowed',
          `Component ${instance.component} is not allowed by template ${request.template}`,
        );
      }
      const componentReference = parseRef(instance.component);
      const definition = await this.definitions.findComponentDefinition(
        transaction,
        componentReference.name,
        componentReference.version,
      );
      if (definition === undefined) {
        throw new DomainError(
          'component_definition_not_found',
          `Component definition ${instance.component} was not found`,
        );
      }
      if (definition.retired_at !== null) {
        throw new DomainError(
          'component_definition_retired',
          `Component definition ${instance.component} is retired`,
        );
      }
      addReference({
        kind: 'component',
        id: definition.id,
        name: definition.name,
        version: definition.version,
        contentDigest: definition.content_digest,
      });

      const ports = new Map<string, ResolvedPort>();
      for (const port of await this.definitions.listPorts(
        transaction,
        definition.id,
      )) {
        ports.set(port.name, {
          direction: port.direction as PortDirection,
          schemaId: port.schema_id,
        });
        const schema = await this.definitions.findArtifactSchemaById(
          transaction,
          port.schema_id,
        );
        if (schema === undefined) {
          throw new DomainError(
            'artifact_schema_not_found',
            `Artifact schema ${port.schema_id} for ${instance.component}.${port.name} was not found`,
          );
        }
        if (schema.retired_at !== null) {
          throw new DomainError(
            'artifact_schema_retired',
            `Artifact schema ${schema.name}@${schema.version} is retired`,
          );
        }
        addReference({
          kind: 'schema',
          id: schema.id,
          name: schema.name,
          version: schema.version,
          contentDigest: schema.content_digest,
        });
      }

      const baseConfiguration = bindParameters(
        (instance.configuration ?? {}) as Json,
        parameters,
      );
      const overrideConfiguration = bindParameters(
        (configurationOverrides[instance.name] ?? {}) as Json,
        parameters,
      );
      resolvedInstances.set(instance.name, {
        name: instance.name,
        component: instance.component,
        definitionId: definition.id,
        configuration: mergeObjects(
          jsonObject(baseConfiguration, `Configuration for ${instance.name}`),
          jsonObject(
            overrideConfiguration,
            `Configuration override for ${instance.name}`,
          ),
        ),
        ports,
      });
    }

    const resolveSchemaContract = async (
      reference: unknown,
      label: string,
    ): Promise<string> => {
      const naturalKey = parseSchemaRef(reference, label);
      const schema = await this.definitions.findArtifactSchema(
        transaction,
        naturalKey.name,
        naturalKey.version,
      );
      if (schema === undefined) {
        throw new DomainError(
          'artifact_schema_not_found',
          `Artifact schema ${naturalKey.name}@${naturalKey.version} was not found`,
        );
      }
      if (schema.retired_at !== null) {
        throw new DomainError(
          'artifact_schema_retired',
          `Artifact schema ${naturalKey.name}@${naturalKey.version} is retired`,
        );
      }
      addReference({
        kind: 'schema',
        id: schema.id,
        name: schema.name,
        version: schema.version,
        contentDigest: schema.content_digest,
      });
      return schema.id;
    };

    const inputSchemas = new Map<string, string>();
    for (const input of templateDocument.spec.inputs ?? []) {
      const port = requireNonEmptyString(input?.port, 'Template input port');
      if (inputSchemas.has(port)) {
        throw new DomainError(
          'duplicate_port_identity',
          `Duplicate template input ${port}`,
        );
      }
      inputSchemas.set(
        port,
        await resolveSchemaContract(input.schema ?? input.schemaRef, `Input ${port} schema`),
      );
    }
    const outputSchemas = new Map<string, { schemaId: string; required: boolean }>();
    for (const output of templateDocument.spec.outputs ?? []) {
      const port = requireNonEmptyString(output?.port, 'Template output port');
      if (outputSchemas.has(port)) {
        throw new DomainError(
          'duplicate_port_identity',
          `Duplicate template output ${port}`,
        );
      }
      outputSchemas.set(port, {
        schemaId: await resolveSchemaContract(
          output.schema ?? output.schemaRef,
          `Output ${port} schema`,
        ),
        required: output.required !== false,
      });
    }

    const completionSchema = templateDocument.spec.completion?.requireValidation?.schema;
    if (completionSchema !== undefined) {
      await resolveSchemaContract(completionSchema, 'Completion validation schema');
    }

    for (const reference of templateDocument.spec.policies ?? []) {
      const policyReference = parseRef(
        typeof reference === 'string'
          ? reference
          : `${reference.name}@${reference.version}`,
      );
      const policy = await this.definitions.findPolicy(
        transaction,
        policyReference.name,
        policyReference.version,
      );
      if (policy === undefined || policy.retired_at !== null) {
        throw new DomainError(
          policy === undefined ? 'policy_not_found' : 'policy_retired',
          `Policy ${policyReference.name}@${policyReference.version} is unavailable`,
        );
      }
      addReference({
        kind: 'policy',
        id: policy.id,
        name: policy.name,
        version: policy.version,
        contentDigest: policy.content_digest,
      });
    }

    for (const reference of templateDocument.spec.capabilities ?? []) {
      const capabilityReference = parseRef(
        typeof reference === 'string'
          ? reference
          : `${reference.name}@${reference.version}`,
      );
      const capability = await transaction
        .selectFrom('capabilities')
        .selectAll()
        .where('name', '=', capabilityReference.name)
        .where('version', '=', capabilityReference.version)
        .executeTakeFirst();
      if (capability === undefined || capability.retired_at !== null) {
        throw new DomainError(
          capability === undefined ? 'capability_not_found' : 'capability_retired',
          `Capability ${capabilityReference.name}@${capabilityReference.version} is unavailable`,
        );
      }
      addReference({
        kind: 'capability',
        id: capability.id,
        name: capability.name,
        version: capability.version,
        contentDigest: capability.content_digest,
      });
    }

    for (const [commandType, rule] of Object.entries(
      staticTopology.ingress?.commands ?? {},
    )) {
      const seen = new Set<string>();
      for (const target of (rule as any).targets ?? []) {
        const instance = resolvedInstances.get(target.component);
        const port = instance?.ports.get(target.port);
        if (port?.direction !== 'input') {
          throw new DomainError(
            'invalid_port_reference',
            `Invalid ingress ${commandType} target ${target.component}.${target.port}`,
          );
        }
        const key = `${target.component}.${target.port}`;
        if (seen.has(key)) {
          throw new DomainError(
            'duplicate_ingress_target',
            `Duplicate ingress target ${key}`,
          );
        }
        seen.add(key);
      }
    }

    const persistedConnections: Array<{
      source: ResolvedInstance;
      sourcePort: string;
      target: ResolvedInstance;
      targetPort: string;
    }> = [];
    const connectedOutputs = new Set<string>();
    for (const connection of staticTopology.connections) {
      const sourceEndpoint = endpoint(connection.from);
      const targetEndpoint = endpoint(connection.to);
      if (sourceEndpoint.instance === 'region' && targetEndpoint.instance === 'region') {
        throw new DomainError(
          'invalid_port_reference',
          `Connection ${connection.from} -> ${connection.to} cannot connect two region boundaries`,
        );
      }
      if (sourceEndpoint.instance === 'region') {
        const target = resolvedInstances.get(targetEndpoint.instance);
        const targetPort = target?.ports.get(targetEndpoint.port);
        if (targetPort?.direction !== 'input') {
          throw new DomainError(
            'invalid_port_reference',
            `Invalid connection target ${connection.to}`,
          );
        }
        const declaredSchema = inputSchemas.get(sourceEndpoint.port);
        if (declaredSchema !== undefined && declaredSchema !== targetPort.schemaId) {
          throw new DomainError(
            'incompatible_port_schema',
            `Connection ${connection.from} -> ${connection.to} has incompatible schemas`,
          );
        }
        continue;
      }
      if (targetEndpoint.instance === 'region') {
        const source = resolvedInstances.get(sourceEndpoint.instance);
        const sourcePort = source?.ports.get(sourceEndpoint.port);
        if (sourcePort?.direction !== 'output') {
          throw new DomainError(
            'invalid_port_reference',
            `Invalid connection source ${connection.from}`,
          );
        }
        const declaredOutput = outputSchemas.get(targetEndpoint.port);
        if (
          declaredOutput !== undefined &&
          declaredOutput.schemaId !== sourcePort.schemaId
        ) {
          throw new DomainError(
            'incompatible_port_schema',
            `Connection ${connection.from} -> ${connection.to} has incompatible schemas`,
          );
        }
        connectedOutputs.add(targetEndpoint.port);
        continue;
      }

      const source = resolvedInstances.get(sourceEndpoint.instance);
      const target = resolvedInstances.get(targetEndpoint.instance);
      const sourcePort = source?.ports.get(sourceEndpoint.port);
      const targetPort = target?.ports.get(targetEndpoint.port);
      if (
        source === undefined ||
        target === undefined ||
        sourcePort?.direction !== 'output' ||
        targetPort?.direction !== 'input'
      ) {
        throw new DomainError(
          'invalid_port_reference',
          `Invalid connection ${connection.from} -> ${connection.to}`,
        );
      }
      if (sourcePort.schemaId !== targetPort.schemaId) {
        throw new DomainError(
          'incompatible_port_schema',
          `Connection ${connection.from} -> ${connection.to} has incompatible schemas`,
        );
      }
      persistedConnections.push({
        source,
        sourcePort: sourceEndpoint.port,
        target,
        targetPort: targetEndpoint.port,
      });
    }

    for (const [port, output] of outputSchemas) {
      if (output.required && !connectedOutputs.has(port)) {
        throw new DomainError(
          'missing_required_output',
          `Required template output ${port} is not connected`,
        );
      }
    }

    for (const rule of templateDocument.spec.fanIn ?? []) {
      const target = endpoint(
        requireNonEmptyString(rule?.input, 'Fan-in input endpoint'),
      );
      const port = resolvedInstances.get(target.instance)?.ports.get(target.port);
      const expected = rule?.completion?.expected;
      if (
        port?.direction !== 'input' ||
        !Number.isInteger(expected) ||
        expected <= 0
      ) {
        throw new DomainError(
          'invalid_fan_in_rule',
          `Invalid fan-in rule for ${rule?.input ?? 'unknown input'}`,
        );
      }
    }

    const referencedDefinitions = sortedReferences(references);
    const effectiveTopology = structuredClone(templateDocument);
    effectiveTopology.spec.initialTopology = {
      ...structuredClone(staticTopology),
      instances: [...resolvedInstances.values()].map((instance) => ({
        name: instance.name,
        component: instance.component,
        configuration: instance.configuration,
      })),
    };
    if (effectiveTopology.spec.initialState !== undefined) {
      effectiveTopology.spec.initialState = bindParameters(
        effectiveTopology.spec.initialState,
        parameters,
      );
    }
    effectiveTopology.spec.instantiation = {
      targetRegionId: request.targetRegionId,
      template: {
        id: templateRow.id,
        name: templateRow.name,
        version: templateRow.version,
        contentDigest: templateRow.content_digest,
      },
      parameters,
      componentConfiguration: configurationOverrides,
      referencedDefinitions,
    };

    const digest = canonicalJsonDigest({
      targetRegionId: request.targetRegionId,
      template: {
        id: templateRow.id,
        contentDigest: templateRow.content_digest,
      },
      parameters,
      componentConfiguration: configurationOverrides,
      referencedDefinitions,
      effectiveTopology,
    });

    const activeRevision = await this.topology.activeRevision(
      transaction,
      region.id,
    );
    if (activeRevision !== undefined) {
      if (activeRevision.content_digest === digest) {
        return {
          disposition: 'existing',
          digest,
          region,
          revision: activeRevision,
          template: {
            id: templateRow.id,
            name: templateRow.name,
            version: templateRow.version,
            contentDigest: templateRow.content_digest,
          },
          parameters,
          referencedDefinitions,
        };
      }
      throw new DomainError(
        'template_instantiation_conflict',
        `Region ${region.name} already has a different active topology`,
      );
    }
    if (!['declared', 'starting', 'ready'].includes(region.lifecycle_status)) {
      throw new DomainError(
        'region_not_eligible',
        `Region ${region.name} is not eligible for template instantiation while ${region.lifecycle_status}`,
      );
    }

    const revision = await this.topology.createRevision(
      transaction,
      region.id,
      digest,
      effectiveTopology as Json,
    );
    const instanceIds = new Map<string, string>();
    for (const instance of resolvedInstances.values()) {
      const row = await this.topology.createInstance(transaction, {
        regionId: region.id,
        revisionId: revision.id,
        definitionId: instance.definitionId,
        name: instance.name,
        configuration: instance.configuration,
      });
      instanceIds.set(instance.name, row.id);
    }
    for (const connection of persistedConnections) {
      await this.topology.createConnection(transaction, {
        revisionId: revision.id,
        sourceId: instanceIds.get(connection.source.name)!,
        sourcePort: connection.sourcePort,
        targetId: instanceIds.get(connection.target.name)!,
        targetPort: connection.targetPort,
      });
    }
    await this.topology.activate(transaction, region.id, revision.id);

    return {
      disposition: 'created',
      digest,
      region,
      revision,
      template: {
        id: templateRow.id,
        name: templateRow.name,
        version: templateRow.version,
        contentDigest: templateRow.content_digest,
      },
      parameters,
      referencedDefinitions,
    };
  }

  private validateRequest(request: TemplateInstantiationRequest): void {
    requireNonEmptyString(request.targetRegionId, 'targetRegionId');
    parseRef(requireNonEmptyString(request.template, 'template'));
    if (request.parameters !== undefined) {
      jsonObject(request.parameters, 'parameters');
    }
    if (request.componentConfiguration !== undefined) {
      jsonObject(request.componentConfiguration, 'componentConfiguration');
    }
  }
}
