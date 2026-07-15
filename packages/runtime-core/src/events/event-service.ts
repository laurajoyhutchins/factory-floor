/* eslint-disable @typescript-eslint/no-explicit-any */
import { sql, type Kysely } from 'kysely';
import { createUuidV7, type Database, type Json, type RuntimeDb } from '@factory-floor/db';

export class EventService {
  constructor(private readonly db: Kysely<Database>) {}
  async allocateSequence(db: RuntimeDb, streamKey: string): Promise<string> {
    const row = await sql<{ sequence_number: string }>`
      insert into event_stream_sequences(stream_key, next_sequence_number) values (${streamKey}, 2)
      on conflict (stream_key) do update set next_sequence_number = event_stream_sequences.next_sequence_number + 1
      returning next_sequence_number - 1 as sequence_number
    `.execute(db as any).then(r => r.rows[0]);
    return String(row.sequence_number);
  }
  async insert(db: RuntimeDb, input: { regionId: string; eventType: string; payload: Json; streamKey: string; correlationId?: string | null; sourceKind: string; sourceCommandId?: string | null; sourceEventId?: string | null; sourceExecutionId?: string | null; sourceAttemptId?: string | null; sourceComponentInstanceId?: string | null; sourcePortName?: string | null }) {
    if (input.sourceKind === 'component' && !input.sourcePortName) throw new Error('component events require sourcePortName');
    const sequence = await this.allocateSequence(db, input.streamKey);
    return db.insertInto('events').values({ id:createUuidV7(), region_id:input.regionId, event_type:input.eventType, payload:input.payload, stream_key:input.streamKey, sequence_number:sequence, correlation_id:input.correlationId ?? null, source_kind:input.sourceKind, source_command_id:input.sourceCommandId ?? null, source_event_id:input.sourceEventId ?? null, source_execution_id:input.sourceExecutionId ?? null, source_attempt_id:input.sourceAttemptId ?? null, source_component_instance_id:input.sourceComponentInstanceId ?? null, source_port_name:input.sourcePortName ?? null } as any).returningAll().executeTakeFirstOrThrow();
  }
}
