/* eslint-disable @typescript-eslint/no-explicit-any */
import { type Kysely } from 'kysely';
import { createUuidV7, type Database, type Json } from '@factory-floor/db';
import { commandRequestDigest } from './identity.js';
import { CommandConflictError } from './errors.js';
import { EventService } from '../events/event-service.js';
import { RoutingService } from '../routing/routing-service.js';

export interface SubmitCommandInput { region: string; commandType: string; source: Json; payload: Json; correlationId?: string; idempotencyKey?: string; expiresAt?: string; }
export interface SubmitCommandResult { commandId: string; status: string; correlationId: string; eventId: string; deliveryIds: string[]; disposition: 'accepted'|'replayed'|'rejected'; rejection?: unknown; }

export class CommandService {
  constructor(private readonly db: Kysely<Database>, private readonly events = new EventService(db), private readonly routing = new RoutingService(db), private readonly clock = () => new Date()) {}
  async submit(input: SubmitCommandInput): Promise<SubmitCommandResult> {
    if (!input.commandType?.trim()) throw new Error('commandType is required');
    const digest = commandRequestDigest(input);
    return this.db.transaction().execute(async trx => {
      const regionName = input.region.replace(/^\//,'');
      const region = await trx.selectFrom('regions').selectAll().where('name','=',regionName).executeTakeFirst();
      if (!region) throw new Error('region_not_found');
      const revision = region.active_topology_revision_id ? await trx.selectFrom('topology_revisions').selectAll().where('id','=',region.active_topology_revision_id).executeTakeFirst() : undefined;
      const existing = input.idempotencyKey ? await trx.selectFrom('commands').selectAll().where('region_id','=',region.id).where('idempotency_key','=',input.idempotencyKey).executeTakeFirst() : undefined;
      if (existing) {
        if (existing.request_digest !== digest) throw new CommandConflictError('Idempotency key conflicts with a different command request');
        const ev = await trx.selectFrom('events').selectAll().where('source_command_id','=',existing.id).orderBy('created_at','asc').executeTakeFirstOrThrow();
        const deliveries = await trx.selectFrom('deliveries').selectAll().where('source_command_id','=',existing.id).execute();
        return { commandId:existing.id, status:existing.status, correlationId:existing.correlation_id ?? existing.id, eventId:ev.id, deliveryIds:deliveries.map(d=>d.id), disposition: existing.status === 'rejected' ? 'rejected' : 'replayed', rejection: existing.rejection ?? undefined };
      }
      const expired = input.expiresAt !== undefined && new Date(input.expiresAt) <= this.clock();
      const semanticReject = !revision ? { code:'no_active_topology', message:'Region has no active topology revision' } : undefined;
      const rejected = expired ? { code:'command_expired', message:'Command expiry is in the past' } : semanticReject;
      const id = createUuidV7();
      const correlationId = input.correlationId ?? id;
      const command = await trx.insertInto('commands').values({ id, region_id:region.id, command_type:input.commandType, payload:input.payload ?? {}, source:input.source ?? {}, status: rejected ? 'rejected' : 'accepted', correlation_id:correlationId, idempotency_key:input.idempotencyKey ?? null, expires_at:input.expiresAt ?? null, request_digest:digest, rejection:rejected as any ?? null, accepted_at:rejected ? null : this.clock(), rejected_at:rejected ? this.clock() : null } as any).returningAll().executeTakeFirstOrThrow();
      const event = await this.events.insert(trx, { regionId:region.id, eventType: rejected ? 'command.rejected' : 'command.accepted', payload: rejected ? rejected as any : input.payload ?? {}, streamKey:`region:${region.id}:commands`, correlationId, sourceKind:'command', sourceCommandId:command.id });
      const deliveries = rejected ? [] : await this.routing.routeCommand(trx, command as any, revision! as any);
      return { commandId:command.id, status:command.status, correlationId, eventId:event.id, deliveryIds:deliveries.map(d=>d.id), disposition: rejected ? 'rejected' : 'accepted', rejection:rejected };
    });
  }
}
