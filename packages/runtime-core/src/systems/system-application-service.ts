/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Kysely } from 'kysely';
import type { Database, Json } from '@factory-floor/db';
import { DefinitionRepository, isUniqueViolation, TopologyRepository } from '@factory-floor/db';
import { canonicalJsonDigest } from '../declarations/canonical-json.js';
import { DomainError } from '../declarations/errors.js';
import {
  validateSimpleDeclaration,
  validateStaticTopology,
  validateSystemDeclaration,
} from '../declarations/validation.js';

export interface SystemApplyResult {
  disposition: 'created' | 'existing';
  digest: string;
  regions: unknown[];
}

function parseRef(reference: string): { name: string; version: string } {
  const separator = reference.lastIndexOf('@');
  if (separator < 1 || separator === reference.length - 1) {
    throw new DomainError('invalid_declaration', `Invalid reference ${reference}`);
  }
  return { name: reference.slice(0, separator), version: reference.slice(separator + 1) };
}

function endpoint(value: string): { instance: string; port: string } {
  const separator = value.lastIndexOf('.');
  if (separator < 1 || separator === value.length - 1) {
    throw new DomainError('invalid_declaration', `Invalid endpoint ${value}`);
  }
  return { instance: value.slice(0, separator), port: value.slice(separator + 1) };
}

export class SystemApplicationService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly definitions = new DefinitionRepository(),
    private readonly topology = new TopologyRepository(),
  ) {}

  async apply(document: any): Promise<SystemApplyResult> {
    validateSystemDeclaration(document);
    try {
      return await this.applyOnce(document);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.applyOnce(document);
    }
  }

  private async applyOnce(document: any): Promise<SystemApplyResult> {
    return this.db.transaction().execute(async (transaction) => {
      const rootName = document.spec.rootRegion.id as string;
      let disposition: 'created' | 'existing' = 'existing';

      let root = await this.topology.findRoot(transaction, rootName);
      if (root === undefined) {
        root = await this.topology.createRegion(transaction, rootName, null);
        disposition = 'created';
      }

      const regionRows = new Map<string, Awaited<ReturnType<TopologyRepository['createRegion']>>>();
      for (const regionDeclaration of document.spec.regions) {
        let region = await this.topology.findChild(transaction, root.id, regionDeclaration.id);
        if (region === undefined) {
          region = await this.topology.createRegion(transaction, regionDeclaration.id, root.id);
          disposition = 'created';
        }
        regionRows.set(regionDeclaration.id, region);
      }

      const investigationDeclaration = document.spec.regions.find((region: any) => region.id === 'investigation');
      if (investigationDeclaration === undefined) {
        throw new DomainError('invalid_declaration', 'System must declare the investigation region');
      }
      const investigationRegion = regionRows.get('investigation');
      if (investigationRegion === undefined) {
        throw new DomainError('invalid_declaration', 'Investigation region was not created');
      }

      const templateReference = parseRef(investigationDeclaration.template);
      const templateRow = await this.definitions.findTemplate(
        transaction,
        templateReference.name,
        templateReference.version,
      );
      if (templateRow === undefined) {
        throw new DomainError(
          'template_not_found',
          `Template ${investigationDeclaration.template} was not found`,
        );
      }

      const templateDocument = templateRow.template as any;
      validateSimpleDeclaration(templateDocument, 'Template');
      const staticTopology = templateDocument.spec.initialTopology;
      if (staticTopology === undefined) {
        throw new DomainError(
          'invalid_declaration',
          `Template ${investigationDeclaration.template} does not define spec.initialTopology`,
        );
      }
      validateStaticTopology(staticTopology);

      const digest = canonicalJsonDigest({
        system: document,
        templateDigest: templateRow.content_digest,
      });
      const activeRevision = await this.topology.activeRevision(transaction, investigationRegion.id);
      if (activeRevision !== undefined) {
        if (activeRevision.content_digest === digest) {
          return { disposition, digest, regions: [root, ...regionRows.values()] };
        }
        throw new DomainError('system_conflict', 'Static system exists with different content');
      }

      const definitionByInstance = new Map<string, { id: string; ports: Set<string> }>();
      for (const instance of staticTopology.instances) {
        const reference = parseRef(instance.component);
        const definition = await this.definitions.findComponentDefinition(
          transaction,
          reference.name,
          reference.version,
        );
        if (definition === undefined) {
          throw new DomainError(
            'component_definition_not_found',
            `Component definition ${instance.component} was not found`,
          );
        }
        const ports = await this.definitions.listPorts(transaction, definition.id);
        definitionByInstance.set(instance.name, {
          id: definition.id,
          ports: new Set(ports.map((port) => port.name)),
        });
      }

      for (const connection of staticTopology.connections) {
        const source = endpoint(connection.from);
        const target = endpoint(connection.to);
        if (source.instance === 'region' || target.instance === 'region') continue;
        if (
          !definitionByInstance.get(source.instance)?.ports.has(source.port)
          || !definitionByInstance.get(target.instance)?.ports.has(target.port)
        ) {
          throw new DomainError(
            'invalid_port_reference',
            `Invalid connection ${connection.from} -> ${connection.to}`,
          );
        }
      }

      const revision = await this.topology.createRevision(
        transaction,
        investigationRegion.id,
        digest,
        templateDocument as Json,
      );
      const instanceIds = new Map<string, string>();
      for (const instance of staticTopology.instances) {
        const definition = definitionByInstance.get(instance.name)!;
        const row = await this.topology.createInstance(transaction, {
          regionId: investigationRegion.id,
          revisionId: revision.id,
          definitionId: definition.id,
          name: instance.name,
          configuration: (instance.configuration ?? {}) as Json,
        });
        instanceIds.set(instance.name, row.id);
      }

      for (const connection of staticTopology.connections) {
        const source = endpoint(connection.from);
        const target = endpoint(connection.to);
        if (source.instance === 'region' || target.instance === 'region') continue;
        await this.topology.createConnection(transaction, {
          revisionId: revision.id,
          sourceId: instanceIds.get(source.instance)!,
          sourcePort: source.port,
          targetId: instanceIds.get(target.instance)!,
          targetPort: target.port,
        });
      }

      await this.topology.activate(transaction, investigationRegion.id, revision.id);
      return { disposition: 'created', digest, regions: [root, ...regionRows.values()] };
    });
  }
}
