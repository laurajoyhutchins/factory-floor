import type { RuntimeDb, Json } from '../database.js';
export class RuntimeRepository {
  async createRegion(
    db: RuntimeDb,
    input: { name: string; parentRegionId?: string | null },
  ) {
    return db
      .insertInto('regions')
      .values({
        name: input.name,
        parent_region_id: input.parentRegionId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async createCommand(
    db: RuntimeDb,
    input: {
      regionId: string;
      commandType: string;
      payload: Json;
      idempotencyKey?: string | null;
    },
  ) {
    return db
      .insertInto('commands')
      .values({
        region_id: input.regionId,
        command_type: input.commandType,
        payload: input.payload,
        idempotency_key: input.idempotencyKey ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async createCommandDelivery(
    db: RuntimeDb,
    input: {
      regionId: string;
      topologyRevisionId: string;
      targetComponentInstanceId: string;
      targetPortName: string;
      commandId: string;
    },
  ) {
    return db
      .insertInto('deliveries')
      .values({
        region_id: input.regionId,
        topology_revision_id: input.topologyRevisionId,
        target_component_instance_id: input.targetComponentInstanceId,
        target_port_name: input.targetPortName,
        source_command_id: input.commandId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
