/* eslint-disable @typescript-eslint/no-explicit-any */
import { sql, type Kysely } from 'kysely';
import { createUuidV7, type Database } from '@factory-floor/db';
import { inputSetDigest, type InputIdentity } from '../commands/identity.js';
import { generateLeaseToken, validateLeaseDuration } from './lease.js';

export interface PollForExecutionOptions { owner: string; leaseDurationMs: number; }
export interface ScheduledAttempt { executionId: string; attemptId: string; attemptNumber: number; leaseToken: string; leaseExpiresAt: string; inputs: { portName:string; deliveryId:string; payload:unknown }[]; }

export class SchedulerService {
  constructor(private readonly db: Kysely<Database>, private readonly clock = () => new Date()) {}
  async pollForExecution(options: PollForExecutionOptions): Promise<ScheduledAttempt | null> {
    validateLeaseDuration(options.leaseDurationMs);
    const now = this.clock(); const leaseExpiresAt = new Date(now.getTime()+options.leaseDurationMs); const leaseToken = generateLeaseToken();
    return this.db.transaction().execute(async trx => {
      const candidate = await sql<any>`select * from deliveries where status = 'ready' and available_at <= ${now} order by available_at, created_at for update skip locked limit 1`.execute(trx as any).then(r=>r.rows[0]);
      if (!candidate) return null;
      const region = await trx.selectFrom('regions').selectAll().where('id','=',candidate.region_id).executeTakeFirstOrThrow();
      const component = await trx.selectFrom('component_instances').selectAll().where('id','=',candidate.target_component_instance_id).executeTakeFirstOrThrow();
      const required = await trx.selectFrom('port_definitions').selectAll().where('component_definition_id','=',component.component_definition_id).where('direction','=','input').where('required','=',true).orderBy('name').execute();
      const selected:any[] = [];
      for (const port of required) {
        const rows = await sql<any>`select * from deliveries where status = 'ready' and region_id=${candidate.region_id} and topology_revision_id=${candidate.topology_revision_id} and target_component_instance_id=${candidate.target_component_instance_id} and correlation_id=${candidate.correlation_id} and target_port_name=${port.name} and available_at <= ${now} order by created_at, id for update`.execute(trx as any).then(r=>r.rows);
        if (rows.length === 0) return null;
        if (rows.length > 1) throw new Error(`ambiguous duplicate deliveries for port ${port.name}`);
        selected.push(rows[0]);
      }
      const optional = await sql<any>`select d.* from deliveries d join port_definitions p on p.component_definition_id=${component.component_definition_id} and p.name=d.target_port_name and p.direction='input' and p.required=false where d.status='ready' and d.region_id=${candidate.region_id} and d.topology_revision_id=${candidate.topology_revision_id} and d.target_component_instance_id=${candidate.target_component_instance_id} and d.correlation_id=${candidate.correlation_id} and d.available_at <= ${now} order by d.target_port_name, d.created_at, d.id for update`.execute(trx as any).then(r=>r.rows);
      selected.push(...optional);
      const identities: InputIdentity[] = selected.map(d => ({ portName:d.target_port_name, deliveryId:d.id, sourceKind:d.source_command_id ? 'command':'event', sourceId:d.source_command_id ?? d.source_event_id, payloadDigest:d.input_payload_digest }));
      const digest = inputSetDigest(identities);
      const trigger = [...selected].sort((a,b)=>String(a.id).localeCompare(String(b.id)))[0];
      let execution = await trx.selectFrom('executions').selectAll().where('region_id','=',candidate.region_id).where('component_instance_id','=',candidate.target_component_instance_id).where('topology_revision_id','=',candidate.topology_revision_id).where('lifecycle_epoch','=',region.lifecycle_epoch).where('input_set_digest','=',digest).executeTakeFirst();
      if (!execution) execution = await trx.insertInto('executions').values({ id:createUuidV7(), delivery_id:trigger.id, region_id:candidate.region_id, component_instance_id:candidate.target_component_instance_id, topology_revision_id:candidate.topology_revision_id, lifecycle_epoch:region.lifecycle_epoch, input_set_digest:digest, status:'running' } as any).returningAll().executeTakeFirstOrThrow();
      for (const d of selected) await trx.insertInto('execution_inputs').values({ id:createUuidV7(), execution_id:execution.id, port_name:d.target_port_name, delivery_id:d.id, payload:d.input_payload } as any).onConflict(oc=>oc.columns(['execution_id','port_name','delivery_id']).doNothing()).execute();
      let attempt = await trx.selectFrom('execution_attempts').selectAll().where('execution_id','=',execution.id).where('attempt_number','=',1).executeTakeFirst();
      if (!attempt) attempt = await trx.insertInto('execution_attempts').values({ id:createUuidV7(), execution_id:execution.id, attempt_number:1, status:'leased', lease_owner:options.owner, lease_token:leaseToken, lease_expires_at:leaseExpiresAt, started_at:now } as any).returningAll().executeTakeFirstOrThrow();
      await trx.updateTable('deliveries').set({ status:'leased', lease_owner:options.owner, lease_token:attempt.lease_token ?? leaseToken, lease_expires_at:leaseExpiresAt, attempts_count: sql`attempts_count + 1` as any }).where('id','in',selected.map(d=>d.id)).execute();
      return { executionId:execution.id, attemptId:attempt.id, attemptNumber:1, leaseToken:attempt.lease_token ?? leaseToken, leaseExpiresAt:leaseExpiresAt.toISOString(), inputs:selected.map(d=>({ portName:d.target_port_name, deliveryId:d.id, payload:d.input_payload })) };
    });
  }
  listExpiredLeases(now = this.clock()) { return this.db.selectFrom('execution_attempts').selectAll().where('status','in',['leased','running']).where('lease_expires_at','<',now).execute(); }
}
