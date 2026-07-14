import type { RuntimeDb, Json } from '../database.js';
import { createUuidV7 } from '../ids.js';
export class DefinitionRepository {
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
    },
  ) {
    return db
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
  }
}
