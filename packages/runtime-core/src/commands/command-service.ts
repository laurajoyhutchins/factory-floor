/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Kysely } from 'kysely';
import {
  createUuidV7,
  type Database,
  type Json,
  type RuntimeDb,
} from '@factory-floor/db';
import { commandRequestDigest } from './identity.js';
import { CommandConflictError } from './errors.js';
import { EventService } from '../events/event-service.js';
import { RoutingService } from '../routing/routing-service.js';

export interface SubmitCommandInput {
  region: string;
  commandType: string;
  source: Json;
  payload: Json;
  correlationId?: string;
  idempotencyKey?: string;
  expiresAt?: string;
}
export interface SubmitCommandResult {
  commandId: string;
  status: string;
  correlationId: string;
  eventId: string;
  deliveryIds: string[];
  disposition: 'accepted' | 'replayed' | 'rejected';
  rejection?: unknown;
}

export class CommandService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly events = new EventService(db),
    private readonly routing = new RoutingService(db),
    private readonly clock = () => new Date(),
  ) {}

  async submit(input: SubmitCommandInput): Promise<SubmitCommandResult> {
    if (!input.commandType?.trim()) throw new Error('commandType is required');
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime()))
      throw new Error('expiresAt must be a valid timestamp');
    const digest = commandRequestDigest(input);

    return this.db.transaction().execute(async (trx) => {
      const regionName = input.region.replace(/^\//, '');
      const region = await trx
        .selectFrom('regions')
        .selectAll()
        .where('name', '=', regionName)
        .executeTakeFirst();
      if (!region) throw new Error('region_not_found');
      const revision = region.active_topology_revision_id
        ? await trx
            .selectFrom('topology_revisions')
            .selectAll()
            .where('id', '=', region.active_topology_revision_id)
            .executeTakeFirst()
        : undefined;

      if (input.idempotencyKey) {
        const existing = await trx
          .selectFrom('commands')
          .selectAll()
          .where('region_id', '=', region.id)
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst();
        if (existing) return this.replay(trx, existing, digest);
      }

      const now = this.clock();
      const expired = expiresAt !== null && expiresAt <= now;
      const rejected = expired
        ? { code: 'command_expired', message: 'Command expiry is in the past' }
        : !revision
          ? {
              code: 'no_active_topology',
              message: 'Region has no active topology revision',
            }
          : undefined;
      const id = createUuidV7();
      const correlationId = input.correlationId ?? id;
      const values = {
        id,
        region_id: region.id,
        command_type: input.commandType,
        payload: input.payload ?? {},
        source: input.source ?? {},
        status: rejected ? 'rejected' : 'accepted',
        correlation_id: correlationId,
        idempotency_key: input.idempotencyKey ?? null,
        expires_at: expiresAt,
        request_digest: digest,
        rejection: (rejected as any) ?? null,
        accepted_at: rejected ? null : now,
        rejected_at: rejected ? now : null,
      } as any;

      const command = input.idempotencyKey
        ? await trx
            .insertInto('commands')
            .values(values)
            .onConflict((conflict) =>
              conflict.columns(['region_id', 'idempotency_key']).doNothing(),
            )
            .returningAll()
            .executeTakeFirst()
        : await trx
            .insertInto('commands')
            .values(values)
            .returningAll()
            .executeTakeFirstOrThrow();

      if (!command) {
        const concurrent = await trx
          .selectFrom('commands')
          .selectAll()
          .where('region_id', '=', region.id)
          .where('idempotency_key', '=', input.idempotencyKey!)
          .executeTakeFirstOrThrow();
        return this.replay(trx, concurrent, digest);
      }

      const event = await this.events.insert(trx, {
        regionId: region.id,
        eventType: rejected ? 'command.rejected' : 'command.accepted',
        payload: rejected ? (rejected as any) : (input.payload ?? {}),
        streamKey: `region:${region.id}:commands`,
        correlationId,
        sourceKind: 'command',
        sourceCommandId: command.id,
      });
      const deliveries = rejected
        ? []
        : await this.routing.routeCommand(
            trx,
            command as any,
            revision! as any,
          );
      return {
        commandId: command.id,
        status: command.status,
        correlationId,
        eventId: event.id,
        deliveryIds: deliveries.map((delivery) => delivery.id),
        disposition: rejected ? 'rejected' : 'accepted',
        rejection: rejected,
      };
    });
  }

  private async replay(
    db: RuntimeDb,
    existing: any,
    digest: string,
  ): Promise<SubmitCommandResult> {
    if (existing.request_digest !== digest)
      throw new CommandConflictError(
        'Idempotency key conflicts with a different command request',
      );
    const event = await db
      .selectFrom('events')
      .selectAll()
      .where('source_command_id', '=', existing.id)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .executeTakeFirstOrThrow();
    const deliveries = await db
      .selectFrom('deliveries')
      .selectAll()
      .where('source_command_id', '=', existing.id)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return {
      commandId: existing.id,
      status: existing.status,
      correlationId: existing.correlation_id,
      eventId: event.id,
      deliveryIds: deliveries.map((delivery) => delivery.id),
      disposition: existing.status === 'rejected' ? 'rejected' : 'replayed',
      rejection: existing.rejection ?? undefined,
    };
  }
}
