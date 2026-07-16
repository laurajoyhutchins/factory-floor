/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Kysely } from 'kysely';
import type { Database, Json } from '@factory-floor/db';
import { DefinitionRepository, isUniqueViolation } from '@factory-floor/db';
import { canonicalJsonDigest } from '../declarations/canonical-json.js';
import { DomainError } from '../declarations/errors.js';
import {
  validateArtifactSchemaDeclaration,
  validateComponentDefinitionDeclaration,
  validateSimpleDeclaration,
} from '../declarations/validation.js';
export interface RegistrationResult<T> {
  entity: T;
  disposition: 'created' | 'existing';
  digest: string;
}
type AnyRow = {
  id: string;
  name: string;
  version: string;
  content_digest: string;
};
export class RegistrationService {
  constructor(
    private db: Kysely<Database>,
    private repo = new DefinitionRepository(),
  ) {}
  private async idempotent<T extends AnyRow>(
    find: (db: any) => Promise<T | undefined>,
    create: (db: any) => Promise<T>,
    digest: string,
  ): Promise<RegistrationResult<T>> {
    const existing = await find(this.db);
    if (existing) {
      if (existing.content_digest === digest)
        return { entity: existing, disposition: 'existing', digest };
      throw new DomainError(
        'registration_conflict',
        'Registration exists with different content',
      );
    }
    try {
      const entity = await create(this.db);
      return { entity, disposition: 'created', digest };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const row = await find(this.db);
      if (row?.content_digest === digest)
        return { entity: row, disposition: 'existing', digest };
      throw new DomainError(
        'registration_conflict',
        'Registration exists with different content',
      );
    }
  }
  registerArtifactSchema(doc: any) {
    validateArtifactSchemaDeclaration(doc);
    const digest = canonicalJsonDigest(doc);
    const { name, version } = doc.metadata;
    return this.idempotent(
      (db) => this.repo.findArtifactSchema(db, name, version),
      (db) =>
        this.repo.createArtifactSchema(db, {
          name,
          version,
          contentDigest: digest,
          schema: doc.spec.schema as Json,
        }),
      digest,
    );
  }
  async registerComponentDefinition(doc: any) {
    validateComponentDefinitionDeclaration(doc);
    const digest = canonicalJsonDigest(doc);
    const { name, version } = doc.metadata;
    const ports = [] as {
      name: string;
      direction: 'input' | 'output' | 'state';
      schemaId: string;
      required: boolean;
    }[];
    for (const p of doc.spec.ports) {
      const ref = p.schema ?? p.schemaRef;
      const schema = await this.repo.findArtifactSchema(
        this.db,
        ref.name,
        ref.version,
      );
      if (!schema)
        throw new DomainError(
          'referenced_schema_not_found',
          `Artifact schema ${ref.name}@${ref.version} was not found`,
        );
      ports.push({
        name: p.name,
        direction: p.direction,
        schemaId: schema.id,
        required: p.required,
      });
    }
    return this.idempotent(
      (db) => this.repo.findComponentDefinition(db, name, version),
      () =>
        this.db
          .transaction()
          .execute((trx) =>
            this.repo.createComponentDefinition(trx, {
              name,
              version,
              contentDigest: digest,
              definition: doc as Json,
              ports,
            }),
          ),
      digest,
    );
  }
  registerTemplate(doc: any) {
    validateSimpleDeclaration(doc, 'Template');
    const digest = canonicalJsonDigest(doc);
    const { name, version } = doc.metadata;
    return this.idempotent(
      (db) => this.repo.findTemplate(db, name, version),
      (db) =>
        this.repo.createTemplate(db, {
          name,
          version,
          contentDigest: digest,
          template: doc as Json,
        }),
      digest,
    );
  }
  registerPolicy(doc: any) {
    validateSimpleDeclaration(doc, 'Policy');
    const digest = canonicalJsonDigest(doc);
    const { name, version } = doc.metadata;
    return this.idempotent(
      (db) => this.repo.findPolicy(db, name, version),
      (db) =>
        this.repo.createPolicy(db, {
          name,
          version,
          contentDigest: digest,
          policy: doc as Json,
        }),
      digest,
    );
  }
}
