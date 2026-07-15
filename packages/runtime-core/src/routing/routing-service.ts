/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Kysely } from 'kysely';
import {
  createUuidV7,
  type Database,
  type Json,
  type RuntimeDb,
} from '@factory-floor/db';
import { payloadDigest } from '../commands/identity.js';

function topologyIngress(
  topology: any,
  commandType: string,
): { component: string; port: string }[] {
  const commands =
    topology?.spec?.initialTopology?.ingress?.commands ??
    topology?.ingress?.commands ??
    {};
  return commands[commandType]?.targets ?? [];
}

export class RoutingService {
  constructor(private readonly db: Kysely<Database>) {}

  async routeCommand(
    db: RuntimeDb,
    command: {
      id: string;
      region_id: string;
      command_type: string;
      payload: Json;
      correlation_id: string | null;
    },
    revision: { id: string; topology: Json },
  ) {
    const targets = topologyIngress(revision.topology as any, command.command_type);
    const deliveries = [];
    for (const target of targets) {
      const instance = await db
        .selectFrom('component_instances')
        .selectAll()
        .where('topology_revision_id', '=', revision.id)
        .where('name', '=', target.component)
        .executeTakeFirstOrThrow();
      const inserted = await db
        .insertInto('deliveries')
        .values({
          id: createUuidV7(),
          region_id: command.region_id,
          topology_revision_id: revision.id,
          target_component_instance_id: instance.id,
          target_port_name: target.port,
          source_command_id: command.id,
          correlation_id: command.correlation_id ?? command.id,
          input_payload: command.payload,
          input_payload_digest: payloadDigest(command.payload),
        } as any)
        .onConflict((conflict) =>
          conflict
            .columns([
              'source_command_id',
              'topology_revision_id',
              'target_component_instance_id',
              'target_port_name',
            ])
            .where('source_command_id', 'is not', null)
            .doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      deliveries.push(
        inserted ??
          (await db
            .selectFrom('deliveries')
            .selectAll()
            .where('source_command_id', '=', command.id)
            .where('topology_revision_id', '=', revision.id)
            .where('target_component_instance_id', '=', instance.id)
            .where('target_port_name', '=', target.port)
            .executeTakeFirstOrThrow()),
      );
    }
    return deliveries;
  }

  async routeComponentEvent(
    db: RuntimeDb,
    event: {
      id: string;
      region_id: string;
      payload: Json;
      correlation_id: string | null;
      source_component_instance_id: string | null;
      source_port_name: string | null;
    },
    topologyRevisionId: string,
  ) {
    if (!event.source_component_instance_id || !event.source_port_name)
      throw new Error('component event requires source component and port');
    const connections = await db
      .selectFrom('connections')
      .selectAll()
      .where('topology_revision_id', '=', topologyRevisionId)
      .where(
        'source_component_instance_id',
        '=',
        event.source_component_instance_id,
      )
      .where('source_port_name', '=', event.source_port_name)
      .execute();
    const deliveries = [];
    for (const connection of connections) {
      const inserted = await db
        .insertInto('deliveries')
        .values({
          id: createUuidV7(),
          region_id: event.region_id,
          topology_revision_id: topologyRevisionId,
          target_component_instance_id:
            connection.target_component_instance_id,
          target_port_name: connection.target_port_name,
          source_event_id: event.id,
          correlation_id: event.correlation_id ?? event.id,
          input_payload: event.payload,
          input_payload_digest: payloadDigest(event.payload),
        } as any)
        .onConflict((conflict) =>
          conflict
            .columns([
              'source_event_id',
              'topology_revision_id',
              'target_component_instance_id',
              'target_port_name',
            ])
            .where('source_event_id', 'is not', null)
            .doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      deliveries.push(
        inserted ??
          (await db
            .selectFrom('deliveries')
            .selectAll()
            .where('source_event_id', '=', event.id)
            .where('topology_revision_id', '=', topologyRevisionId)
            .where(
              'target_component_instance_id',
              '=',
              connection.target_component_instance_id,
            )
            .where('target_port_name', '=', connection.target_port_name)
            .executeTakeFirstOrThrow()),
      );
    }
    return deliveries;
  }
}
