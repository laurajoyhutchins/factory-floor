/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Kysely } from 'kysely';
import type { Database } from '@factory-floor/db';
import {
  DefinitionRepository,
  isUniqueViolation,
  TopologyRepository,
} from '@factory-floor/db';
import { canonicalJsonDigest } from '../declarations/canonical-json.js';
import {
  validateSimpleDeclaration,
  validateSystemDeclaration,
} from '../declarations/validation.js';
import { TemplateInstantiationService } from './template-instantiation-service.js';

export interface SystemApplyResult {
  disposition: 'created' | 'existing';
  digest: string;
  regions: unknown[];
}

export class SystemApplicationService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly definitions = new DefinitionRepository(),
    private readonly topology = new TopologyRepository(),
    private readonly instantiations = new TemplateInstantiationService(
      db,
      definitions,
      topology,
    ),
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

      const regionRows = new Map<
        string,
        Awaited<ReturnType<TopologyRepository['createRegion']>>
      >();
      for (const regionDeclaration of document.spec.regions) {
        let region = await this.topology.findChild(
          transaction,
          root.id,
          regionDeclaration.id,
        );
        if (region === undefined) {
          region = await this.topology.createRegion(
            transaction,
            regionDeclaration.id,
            root.id,
          );
          disposition = 'created';
        }
        regionRows.set(regionDeclaration.id, region);
      }

      const instantiated: Array<{ regionId: string; digest: string }> = [];
      for (const regionDeclaration of document.spec.regions) {
        const [name, version] = String(regionDeclaration.template).split('@');
        const template = await this.definitions.findTemplate(
          transaction,
          name,
          version,
        );

        // Milestone 1 systems include stable boundary regions whose templates are
        // not yet registered. Preserve that compatibility behavior while routing
        // every registered, topology-bearing template through the generic service.
        if (template === undefined) continue;
        const templateDocument = template.template as any;
        validateSimpleDeclaration(templateDocument, 'Template');
        if (templateDocument.spec.initialTopology === undefined) continue;

        const region = regionRows.get(regionDeclaration.id)!;
        const result = await this.instantiations.instantiateInTransaction(
          transaction,
          {
            targetRegionId: region.id,
            template: regionDeclaration.template,
            parameters: regionDeclaration.parameters ?? {},
            componentConfiguration:
              regionDeclaration.componentConfiguration ?? {},
          },
        );
        if (result.disposition === 'created') disposition = 'created';
        instantiated.push({ regionId: region.id, digest: result.digest });
      }

      instantiated.sort((left, right) =>
        left.regionId.localeCompare(right.regionId),
      );
      const digest = canonicalJsonDigest({
        system: document,
        instantiations: instantiated,
      });

      return {
        disposition,
        digest,
        regions: [root, ...regionRows.values()],
      };
    });
  }
}
