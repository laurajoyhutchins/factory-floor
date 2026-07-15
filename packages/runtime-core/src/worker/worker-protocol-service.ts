/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql, type Kysely } from 'kysely';
import { createUuidV7, type Database } from '@factory-floor/db';
import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import { SchedulerService } from '../scheduling/scheduler-service.js';

export type WorkerErrorCode =
  | 'invalid_request' | 'no_work' | 'inactive_attempt' | 'lease_expired'
  | 'stale_lease_token' | 'stale_lifecycle_epoch' | 'cancellation_requested'
  | 'unauthorized_staging_reference' | 'capability_denied'
  | 'duplicate_conflicting_result' | 'unsupported_protocol_version'
  | 'internal_transient_failure';
export class WorkerProtocolError extends Error {
  constructor(readonly code: WorkerErrorCode, message: string, readonly retryable = false, readonly statusCode = 400) { super(message); }
}
export interface WorkerProtocolOptions { leaseDurationMs: number; baseUrl?: string; }
export class WorkerProtocolService {
  constructor(private readonly db: Kysely<Database>, private readonly blobStore: ArtifactBlobStore | undefined, private readonly options: WorkerProtocolOptions, private readonly clock = () => new Date()) {}
  async claim(input: { workerId: string; capabilities: string[] }) {
    const scheduled = await new SchedulerService(this.db, this.clock).pollForExecution({ owner: input.workerId, leaseDurationMs: this.options.leaseDurationMs });
    if (!scheduled) return { protocolVersion: '1.0', claimed: false, retryAfterMs: 250 };
    return { protocolVersion: '1.0', claimed: true, envelope: await this.buildEnvelope(scheduled) };
  }
  private url(path: string) { return new URL(path, this.options.baseUrl ?? 'http://127.0.0.1').toString(); }
  async buildEnvelope(scheduled: { executionId: string; attemptId: string; attemptNumber: number; leaseToken: string; leaseExpiresAt: string; inputs: {portName:string; deliveryId:string; payload: unknown}[] }) {
    const row = await this.db.selectFrom('executions as e').innerJoin('regions as r','r.id','e.region_id').innerJoin('component_instances as c','c.id','e.component_instance_id').innerJoin('component_definitions as d','d.id','c.component_definition_id').select(['e.lifecycle_epoch','c.id as component_id','c.configuration','d.id as definition_id','d.name as definition_name','d.version as definition_version','d.definition']).where('e.id','=',scheduled.executionId).executeTakeFirstOrThrow();
    return {
      protocolVersion: '1.0', executionId: scheduled.executionId, attemptId: scheduled.attemptId, attemptNumber: scheduled.attemptNumber,
      leaseToken: scheduled.leaseToken, leaseExpiresAt: scheduled.leaseExpiresAt, lifecycleEpoch: row.lifecycle_epoch,
      component: { componentId: row.component_id, definitionId: row.definition_id, definitionName: row.definition_name, definitionVersion: row.definition_version, configuration: row.configuration, definition: row.definition },
      inputs: scheduled.inputs.map((i) => ({ portName: i.portName, deliveryId: i.deliveryId, payload: i.payload, artifacts: [], artifactReadUrls: [] })),
      state: null, capabilityHandles: [], heartbeatUrl: this.url('/worker/v1/heartbeat'), cancellationUrl: this.url('/worker/v1/cancellation'), resultSubmissionUrl: this.url('/worker/v1/results'), artifactStagingUrl: this.url('/worker/v1/artifacts/stage'), capabilityInvocationUrl: this.url('/worker/v1/capabilities/invoke'), traceContext: { traceparent: `00-${createHash('sha256').update(scheduled.attemptId).digest('hex').slice(0,32)}-${createHash('sha256').update(scheduled.executionId).digest('hex').slice(0,16)}-01` }, limits: { heartbeatIntervalMs: Math.floor(this.options.leaseDurationMs/3), maxArtifactBytes: 104857600 }, source: { kind: 'execution', executionId: scheduled.executionId, attemptId: scheduled.attemptId }
    };
  }
  async assertActive(input: { executionId: string; attemptId: string; leaseToken: string; lifecycleEpoch: number }) {
    const now = this.clock();
    const row = await this.db.selectFrom('execution_attempts as a').innerJoin('executions as e','e.id','a.execution_id').innerJoin('regions as r','r.id','e.region_id').select(['a.status','a.lease_token','a.lease_expires_at','e.lifecycle_epoch','r.lifecycle_status','e.component_instance_id']).where('a.id','=',input.attemptId).where('a.execution_id','=',input.executionId).executeTakeFirst();
    if (!row || !['leased','running'].includes(row.status)) throw new WorkerProtocolError('inactive_attempt','attempt is not active',false,409);
    if (row.lease_token !== input.leaseToken) throw new WorkerProtocolError('stale_lease_token','lease token is not current',false,409);
    if (row.lifecycle_epoch !== input.lifecycleEpoch) throw new WorkerProtocolError('stale_lifecycle_epoch','lifecycle epoch is not current',false,409);
    if (!row.lease_expires_at || row.lease_expires_at <= now) throw new WorkerProtocolError('lease_expired','lease has expired',true,409);
    return row;
  }
  async heartbeat(input: { executionId:string; attemptId:string; leaseToken:string; lifecycleEpoch:number }) {
    const row = await this.assertActive(input); const expires = new Date(this.clock().getTime()+this.options.leaseDurationMs);
    await this.db.updateTable('execution_attempts').set({ status: 'running', lease_expires_at: expires }).where('id','=',input.attemptId).execute();
    return { protocolVersion:'1.0', leaseValid:true, leaseExpiresAt: expires.toISOString(), cancellation: row.lifecycle_status === 'cancelling' ? 'cancellation_requested' : 'continue' };
  }
  async cancellation(input: { executionId:string; attemptId:string; leaseToken:string; lifecycleEpoch:number }) { try { const row = await this.assertActive(input); return { protocolVersion:'1.0', state: row.lifecycle_status === 'cancelling' ? 'cancellation_requested' : 'continue' }; } catch (e) { if (e instanceof WorkerProtocolError) return { protocolVersion:'1.0', state: e.code === 'inactive_attempt' ? 'attempt_terminal' : 'lease_no_longer_valid' }; throw e; } }
  async stage(input: any) { const row = await this.assertActive(input); const port = await this.db.selectFrom('port_definitions').selectAll().where('component_definition_id','=',sql`(select component_definition_id from component_instances where id = ${row.component_instance_id})` as any).where('direction','=','output').where('name','=',input.portName).executeTakeFirst(); if (!port) throw new WorkerProtocolError('unauthorized_staging_reference','output port is not declared',false,403); const stagedRef = createUuidV7(); return { protocolVersion:'1.0', stagedRef, uploadUrl: this.url(`/worker/v1/artifacts/upload/${stagedRef}`), expiresAt: new Date(this.clock().getTime()+this.options.leaseDurationMs).toISOString() }; }
  async upload(stagedRef: string, input: any, stream: Readable) { if (!this.blobStore) throw new WorkerProtocolError('internal_transient_failure','artifact blob store is not configured',true,503); await this.assertActive(input); const receipt = await this.blobStore.stage(stagedRef, stream, { expectedDigest: input.expectedDigest, expectedSize: BigInt(input.expectedSizeBytes) }); await this.db.insertInto('artifact_staging').values({ id: createUuidV7(), attempt_id: input.attemptId, staged_ref: stagedRef, digest_algorithm:'sha256', digest: receipt.digest, size_bytes: receipt.size.toString(), schema_id: input.schemaId, media_type: input.mediaType, locator: receipt.stagedLocator, status:'staged', metadata: input.metadata ?? {} } as any).onConflict((c)=>c.columns(['attempt_id','staged_ref']).doNothing()).execute(); return { protocolVersion:'1.0', stagedRef, digest: receipt.digest, sizeBytes: Number(receipt.size) }; }
  async submitResult(input: any) { await this.assertActive(input); const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex'); const existing = await sql<any>`select * from worker_result_submissions where attempt_id=${input.attemptId}`.execute(this.db as any).then(r=>r.rows[0]); if (existing) { if (existing.submission_digest === digest) return { protocolVersion:'1.0', accepted:true, duplicate:true, handoff:'recorded_for_task_8_commit' }; throw new WorkerProtocolError('duplicate_conflicting_result','attempt already has a different proposed result',false,409); } for (const ref of input.stagedArtifacts ?? []) { const s = await this.db.selectFrom('artifact_staging').selectAll().where('attempt_id','=',input.attemptId).where('staged_ref','=',ref.stagingId).executeTakeFirst(); if (!s) throw new WorkerProtocolError('unauthorized_staging_reference','staged artifact reference is not authorized for this attempt',false,403); } await sql`insert into worker_result_submissions(id, execution_id, attempt_id, submission_digest, result) values (${createUuidV7()}, ${input.executionId}, ${input.attemptId}, ${digest}, ${JSON.stringify(input)}::jsonb)`.execute(this.db as any); return { protocolVersion:'1.0', accepted:true, duplicate:false, handoff:'recorded_for_task_8_commit' }; }
  async invokeCapability(input: any) { await this.assertActive(input); throw new WorkerProtocolError('capability_denied','capability handle is unknown or denied',false,403); }
}
