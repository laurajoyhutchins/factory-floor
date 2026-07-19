import type { Json, RuntimeDb } from '../database.js';
import { createUuidV7 } from '../ids.js';
export class TopologyRepository {
  findRegion(db: RuntimeDb, id: string) {
    return db
      .selectFrom('regions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }
  findRoot(db: RuntimeDb, name: string) {
    return db
      .selectFrom('regions')
      .selectAll()
      .where('parent_region_id', 'is', null)
      .where('name', '=', name)
      .executeTakeFirst();
  }
  findChild(db: RuntimeDb, parent: string, name: string) {
    return db
      .selectFrom('regions')
      .selectAll()
      .where('parent_region_id', '=', parent)
      .where('name', '=', name)
      .executeTakeFirst();
  }
  findRevision(db: RuntimeDb, regionId: string, digest: string) {
    return db
      .selectFrom('topology_revisions')
      .selectAll()
      .where('region_id', '=', regionId)
      .where('content_digest', '=', digest)
      .executeTakeFirst();
  }
  activeRevision(db: RuntimeDb, regionId: string) {
    return db
      .selectFrom('regions')
      .innerJoin(
        'topology_revisions',
        'topology_revisions.id',
        'regions.active_topology_revision_id',
      )
      .selectAll('topology_revisions')
      .where('regions.id', '=', regionId)
      .executeTakeFirst();
  }
  createRegion(db: RuntimeDb, name: string, parentRegionId: string | null) {
    return db
      .insertInto('regions')
      .values({
        id: createUuidV7(),
        name,
        parent_region_id: parentRegionId,
        lifecycle_status: 'ready',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async createRevision(
    db: RuntimeDb,
    regionId: string,
    digest: string,
    topology: Json,
  ) {
    return db
      .insertInto('topology_revisions')
      .values({
        id: createUuidV7(),
        region_id: regionId,
        revision_number: 1,
        content_digest: digest,
        topology,
        activated_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  activate(db: RuntimeDb, regionId: string, revisionId: string) {
    return db
      .updateTable('regions')
      .set({
        active_topology_revision_id: revisionId,
        lifecycle_status: 'running',
      })
      .where('id', '=', regionId)
      .execute();
  }
  createInstance(
    db: RuntimeDb,
    input: {
      regionId: string;
      revisionId: string;
      definitionId: string;
      name: string;
      configuration: Json;
    },
  ) {
    return db
      .insertInto('component_instances')
      .values({
        id: createUuidV7(),
        region_id: input.regionId,
        topology_revision_id: input.revisionId,
        component_definition_id: input.definitionId,
        name: input.name,
        configuration: input.configuration,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  createConnection(
    db: RuntimeDb,
    input: {
      revisionId: string;
      sourceId: string;
      sourcePort: string;
      targetId: string;
      targetPort: string;
    },
  ) {
    return db
      .insertInto('connections')
      .values({
        id: createUuidV7(),
        topology_revision_id: input.revisionId,
        source_component_instance_id: input.sourceId,
        source_port_name: input.sourcePort,
        target_component_instance_id: input.targetId,
        target_port_name: input.targetPort,
      })
      .execute();
  }
}
