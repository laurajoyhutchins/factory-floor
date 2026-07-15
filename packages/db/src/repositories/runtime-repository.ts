import { createHash } from 'node:crypto';
import type { RuntimeDb, Json } from '../database.js';
import { createUuidV7 } from '../ids.js';

export class RuntimeRepository {
  async createRegion(
    db: RuntimeDb,
    input: { name: string; parentRegionId?: string | null },
  ) {
    return db
      .insertInto('regions')
      .values({
        id: createUuidV7(),
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
    const id = createUuidV7();
    return db
      .insertInto('commands')
      .values({
        id,
        region_id: input.regionId,
        command_type: input.commandType,
        payload: input.payload,
        source: {},
        request_digest: createHash('sha256').update(id).digest('hex'),
        accepted_at: new Date(),
        correlation_id: id,
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
        id: createUuidV7(),
        region_id: input.regionId,
        topology_revision_id: input.topologyRevisionId,
        target_component_instance_id: input.targetComponentInstanceId,
        target_port_name: input.targetPortName,
        source_command_id: input.commandId,
        correlation_id: input.commandId,
        input_payload: {},
        input_payload_digest: createHash('sha256').update('{}').digest('hex'),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
