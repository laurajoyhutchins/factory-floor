import { sql, type Kysely } from 'kysely';
import type { Database } from '../database.js';

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    alter table approvals
      add column decision_reason text,
      add column decision_client_request_id text,
      add column decision_request_digest sha256_digest;

    update approvals
    set decision_reason = coalesce(decision_reason, 'Recorded before operator decision auditing was introduced.'),
        decision_client_request_id = coalesce(decision_client_request_id, 'legacy:' || id::text),
        decision_request_digest = coalesce(
          decision_request_digest,
          repeat('0', 64)::sha256_digest
        )
    where status in ('approved', 'denied');

    alter table approvals
      add constraint approvals_decision_audit_check check (
        (
          status in ('approved', 'denied')
          and decision_reason is not null
          and decision_client_request_id is not null
          and decision_request_digest is not null
        )
        or (
          status not in ('approved', 'denied')
          and decision_reason is null
          and decision_client_request_id is null
          and decision_request_digest is null
        )
      );

    create unique index approvals_decision_idempotency_unique
      on approvals(decided_by, decision_client_request_id)
      where decision_client_request_id is not null;
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`
    drop index if exists approvals_decision_idempotency_unique;
    alter table approvals
      drop constraint if exists approvals_decision_audit_check;
    alter table approvals
      drop column if exists decision_request_digest,
      drop column if exists decision_client_request_id,
      drop column if exists decision_reason;
  `.execute(db);
}
