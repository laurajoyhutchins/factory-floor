/* eslint-disable @typescript-eslint/no-explicit-any */
import { type Kysely } from 'kysely';
import { ArtifactRepository, createUuidV7, type Database } from '@factory-floor/db';
import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import { ArtifactValidationService } from '../artifacts/artifact-validation-service.js';
import { EventService } from '../events/event-service.js';
import { RoutingService } from '../routing/routing-service.js';

export class ExecutionCommitError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); this.name = 'ExecutionCommitError'; }
}

type Staged = { stagingId: string; portName: string; digest: string; sizeBytes: number; mediaType: string; schemaId: string; schemaDigest: string; provenance?: unknown };
type Proposed = { protocolVersion: '1.0'; executionId: string; attemptId: string; leaseToken: string; lifecycleEpoch: number; status: 'completed'|'failed'|'cancelled'; stagedArtifacts: Staged[]; proposedState?: Staged; proposedEvents: any[]; externalActionProposals: any[]; resourceUsage: any; failure?: unknown };

export class ExecutionCommitService {
  private readonly artifacts = new ArtifactRepository();
  private readonly events: EventService;
  private readonly routing: RoutingService;
  constructor(private readonly db: Kysely<Database>, private readonly blobStore: ArtifactBlobStore | undefined, private readonly clock = () => new Date()) {
    this.events = new EventService(db);
    this.routing = new RoutingService(db);
  }

  async commitSubmittedResult(attemptId: string) {
    const submission = await this.db.selectFrom('worker_result_submissions').selectAll().where('attempt_id','=',attemptId).executeTakeFirstOrThrow();
    return this.commit(submission.result as unknown as Proposed);
  }

  async commit(input: Proposed) {
    const promotions: Array<{ stagingId: string; artifactId: string; digest: string; size: bigint }> = [];
    const result = await this.db.transaction().execute(async (trx) => {
      const attempt = await trx.selectFrom('execution_attempts').selectAll().where('id','=',input.attemptId).where('execution_id','=',input.executionId).forUpdate().executeTakeFirst();
      const execution = await trx.selectFrom('executions').selectAll().where('id','=',input.executionId).forUpdate().executeTakeFirst();
      if (!attempt || !execution) throw new ExecutionCommitError('inactive_attempt','attempt is not active');
      if (attempt.status === 'completed' || execution.status === 'completed') return { disposition: 'duplicate' as const };
      if (!['leased','running'].includes(attempt.status)) throw new ExecutionCommitError('inactive_attempt','attempt is not active');
      if (attempt.lease_token !== input.leaseToken) throw new ExecutionCommitError('stale_lease_token','lease token is not current');
      if (!attempt.lease_expires_at || attempt.lease_expires_at <= this.clock()) throw new ExecutionCommitError('lease_expired','lease has expired');
      const region = await trx.selectFrom('regions').selectAll().where('id','=',execution.region_id).forUpdate().executeTakeFirstOrThrow();
      if (execution.lifecycle_epoch !== input.lifecycleEpoch || region.lifecycle_epoch !== input.lifecycleEpoch) throw new ExecutionCommitError('stale_lifecycle_epoch','lifecycle epoch is not current');
      const component = await trx.selectFrom('component_instances').selectAll().where('id','=',execution.component_instance_id).forUpdate().executeTakeFirstOrThrow();
      await trx.selectFrom('topology_revisions').selectAll().where('id','=',execution.topology_revision_id).forUpdate().executeTakeFirstOrThrow();
      const deliveries = await trx.selectFrom('execution_inputs as i').innerJoin('deliveries as d','d.id','i.delivery_id').select(['d.id','d.status']).where('i.execution_id','=',execution.id).orderBy('d.id').forUpdate().execute();

      const ports = await trx.selectFrom('port_definitions').selectAll().where('component_definition_id','=',component.component_definition_id).execute();
      const outputSchemas = new Map(ports.filter(p=>p.direction==='output').map(p=>[p.name,p.schema_id]));
      const artifactIds = new Map<string,string>();
      for (const staged of [...input.stagedArtifacts, ...(input.proposedState ? [input.proposedState] : [])]) {
        const expectedSchema = outputSchemas.get(staged.portName);
        if (!expectedSchema) throw new ExecutionCommitError('undeclared_output_port',`output port ${staged.portName} is not declared`,400);
        if (expectedSchema !== staged.schemaId) throw new ExecutionCommitError('artifact_schema_mismatch','artifact schema does not match declared output port',400);
        const row = await trx.selectFrom('artifact_staging as s').innerJoin('artifact_schemas as schema','schema.id','s.schema_id').select(['s.id','s.attempt_id','s.digest','s.size_bytes','s.schema_id','s.media_type','s.status','schema.content_digest as schema_digest']).where('s.id','=',staged.stagingId).forUpdate().executeTakeFirst();
        if (!row || row.attempt_id !== input.attemptId || row.status !== 'staged' || row.digest !== staged.digest || row.size_bytes !== String(staged.sizeBytes) || row.schema_id !== staged.schemaId || row.media_type !== staged.mediaType || row.schema_digest !== staged.schemaDigest) throw new ExecutionCommitError('invalid_staged_artifact','staged artifact metadata is not authoritative',400);
        if (!this.blobStore) throw new ExecutionCommitError('blob_store_unavailable','artifact blob store is not configured',503);
        await new ArtifactValidationService({ db: trx, repository: this.artifacts, blobStore: this.blobStore, maxJsonBytes: 104857600n }).validateStagedArtifact(row.id);
        let existing = await this.artifacts.lockArtifactByDigest(trx, row.digest);
        if (existing && (existing.size_bytes !== row.size_bytes || existing.schema_id !== row.schema_id || existing.media_type !== row.media_type || existing.state === 'tombstoned')) throw new ExecutionCommitError('artifact_conflict','artifact digest conflicts with existing metadata',409);
        if (!existing) existing = (await this.artifacts.createCommittedArtifactIdempotently(trx,{ digest: row.digest, sizeBytes: row.size_bytes, schemaId: row.schema_id, mediaType: row.media_type, locator: `sha256:${row.digest}`, provenance: { executionId: input.executionId, attemptId: input.attemptId, portName: staged.portName, workerProvenance: staged.provenance ?? null } as any })).artifact;
        await this.artifacts.linkStagingRowToArtifact(trx,row.id,existing.id);
        await trx.insertInto('artifact_derivations').values({ id:createUuidV7(), artifact_id: existing.id, source_artifact_id:null, execution_id: input.executionId, attempt_id: input.attemptId, derivation_type:'execution_output' } as any).onConflict((oc)=>oc.doNothing()).execute();
        artifactIds.set(staged.stagingId, existing.id);
        promotions.push({ stagingId: row.id, artifactId: existing.id, digest: row.digest, size: BigInt(row.size_bytes) });
      }

      await this.writeResourceUsage(trx, execution.region_id, input);
      if (input.status === 'completed') {
        if (input.externalActionProposals.length) throw new ExecutionCommitError('external_action_unauthorized','external actions require authoritative grants',403);
        for (const staged of input.stagedArtifacts) {
          const event = await this.events.insert(trx,{ regionId: execution.region_id, eventType:'component.output', payload:{ portName: staged.portName, artifactId: artifactIds.get(staged.stagingId)! } as any, streamKey:`component:${execution.component_instance_id}:${staged.portName}`, correlationId: (await trx.selectFrom('deliveries').select('correlation_id').where('id','=',execution.delivery_id).executeTakeFirst())?.correlation_id, sourceKind:'component', sourceExecutionId:input.executionId, sourceAttemptId:input.attemptId, sourceComponentInstanceId:execution.component_instance_id, sourcePortName:staged.portName });
          await trx.insertInto('execution_outputs').values({ id:createUuidV7(), execution_id:input.executionId, attempt_id:input.attemptId, port_name:staged.portName, artifact_id:artifactIds.get(staged.stagingId)!, published_event_id:event.id } as any).onConflict((oc)=>oc.columns(['execution_id','port_name','artifact_id']).doNothing()).execute();
          await this.routing.routeComponentEvent(trx,event as any,execution.topology_revision_id);
        }
        for (const eventProposal of input.proposedEvents ?? []) await this.events.insert(trx,{ regionId:execution.region_id,eventType:String(eventProposal.eventType),payload:eventProposal.payload ?? {},streamKey:`execution:${input.executionId}:events`,sourceKind:'attempt',sourceExecutionId:input.executionId,sourceAttemptId:input.attemptId });
        await trx.updateTable('execution_attempts').set({ status:'completed', completed_at:this.clock(), lease_owner:null, lease_token:null, lease_expires_at:null }).where('id','=',input.attemptId).execute();
        await trx.updateTable('executions').set({ status:'completed', completed_at:this.clock() }).where('id','=',input.executionId).execute();
        await trx.updateTable('deliveries').set({ status:'completed', lease_owner:null, lease_token:null, lease_expires_at:null } as any).where('id','in',deliveries.map(d=>d.id)).execute();
        return { disposition:'committed' as const };
      }
      return this.failAndMaybeRetry(trx, execution as any, attempt as any, deliveries.map(d=>d.id), input);
    });
    if (this.blobStore) for (const p of promotions) { try { await this.blobStore.promote(p.stagingId,p.digest,p.size); await this.db.updateTable('artifact_staging').set({status:'promoted',promoted_at:this.clock(),artifact_id:p.artifactId}).where('id','=',p.stagingId).execute(); } catch { /* reconciler recovers */ } }
    return result;
  }

  private async writeResourceUsage(trx: any, regionId: string, input: Proposed) {
    for (const [key,value] of Object.entries(input.resourceUsage ?? {})) if (typeof value === 'number' && value > 0) await trx.insertInto('resource_ledger').values({ id:createUuidV7(), region_id:regionId, execution_id:input.executionId, attempt_id:input.attemptId, resource_type:key, quantity:String(value), unit:key.endsWith('Bytes')?'bytes':key.endsWith('Milliseconds')?'milliseconds':'count', attributes:{} }).execute();
  }
  private async failAndMaybeRetry(trx:any, execution:any, attempt:any, deliveryIds:string[], input:Proposed) {
    const now=this.clock();
    await trx.updateTable('execution_attempts').set({ status: input.status === 'cancelled' ? 'cancelled':'failed', completed_at:now, failure:(input.failure ?? { code: input.status }) as any, lease_owner:null, lease_token:null, lease_expires_at:null }).where('id','=',input.attemptId).execute();
    if (attempt.attempt_number < 3 && input.status === 'failed') {
      const delays=[1000,5000,30000]; const availableAt=new Date(now.getTime()+delays[attempt.attempt_number-1]);
      await trx.insertInto('execution_attempts').values({ id:createUuidV7(), execution_id:execution.id, attempt_number:attempt.attempt_number+1, status:'pending', started_at:availableAt, failure:null } as any).onConflict((oc:any)=>oc.columns(['execution_id','attempt_number']).doNothing()).execute();
      await trx.updateTable('deliveries').set({ status:'ready', available_at:availableAt, lease_owner:null, lease_token:null, lease_expires_at:null }).where('id','in',deliveryIds).execute();
      return { disposition:'retry_scheduled' as const };
    }
    await trx.updateTable('executions').set({ status:'failed', failed_at:now, failure:(input.failure ?? { code: input.status }) as any }).where('id','=',execution.id).execute();
    await trx.updateTable('deliveries').set({ status:'dead_lettered', lease_owner:null, lease_token:null, lease_expires_at:null }).where('id','in',deliveryIds).execute();
    return { disposition:'dead_lettered' as const };
  }
}
