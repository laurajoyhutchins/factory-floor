import type { RuntimeDb, Json } from '../database.js';
import { createUuidV7 } from '../ids.js';
export class DefinitionRepository {
  findArtifactSchema(db: RuntimeDb, name: string, version: string) {
    return db
      .selectFrom('artifact_schemas')
      .selectAll()
      .where('name', '=', name)
      .where('version', '=', version)
      .executeTakeFirst();
  }
  findComponentDefinition(db: RuntimeDb, name: string, version: string) {
    return db
      .selectFrom('component_definitions')
      .selectAll()
      .where('name', '=', name)
      .where('version', '=', version)
      .executeTakeFirst();
  }
  findTemplate(db: RuntimeDb, name: string, version: string) {
    return db
      .selectFrom('templates')
      .selectAll()
      .where('name', '=', name)
      .where('version', '=', version)
      .executeTakeFirst();
  }
  findPolicy(db: RuntimeDb, name: string, version: string) {
    return db
      .selectFrom('policies')
      .selectAll()
      .where('name', '=', name)
      .where('version', '=', version)
      .executeTakeFirst();
  }
  listPorts(db: RuntimeDb, componentDefinitionId: string) {
    return db
      .selectFrom('port_definitions')
      .selectAll()
      .where('component_definition_id', '=', componentDefinitionId)
      .orderBy('name')
      .orderBy('direction')
      .execute();
  }
  async createArtifactSchema(
    db: RuntimeDb,
    input: {
      name: string;
      version: string;
      contentDigest: string;
      schema: Json;
    },
  ) {
    return db
      .insertInto('artifact_schemas')
      .values({
        id: createUuidV7(),
        name: input.name,
        version: input.version,
        content_digest: input.contentDigest,
        schema: input.schema,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async createComponentDefinition(
    db: RuntimeDb,
    input: {
      name: string;
      version: string;
      contentDigest: string;
      definition: Json;
      ports: {
        name: string;
        direction: 'input' | 'output' | 'state';
        schemaId: string;
        required: boolean;
      }[];
    },
  ) {
    const row = await db
      .insertInto('component_definitions')
      .values({
        id: createUuidV7(),
        name: input.name,
        version: input.version,
        content_digest: input.contentDigest,
        definition: input.definition,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    for (const p of input.ports)
      await db
        .insertInto('port_definitions')
        .values({
          id: createUuidV7(),
          component_definition_id: row.id,
          name: p.name,
          direction: p.direction,
          schema_id: p.schemaId,
          required: p.required,
        })
        .execute();
    return row;
  }
  async createTemplate(
    db: RuntimeDb,
    input: {
      name: string;
      version: string;
      contentDigest: string;
      template: Json;
    },
  ) {
    return db
      .insertInto('templates')
      .values({
        id: createUuidV7(),
        name: input.name,
        version: input.version,
        content_digest: input.contentDigest,
        template: input.template,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async createPolicy(
    db: RuntimeDb,
    input: {
      name: string;
      version: string;
      contentDigest: string;
      policy: Json;
    },
  ) {
    return db
      .insertInto('policies')
      .values({
        id: createUuidV7(),
        name: input.name,
        version: input.version,
        content_digest: input.contentDigest,
        policy: input.policy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  );
}
