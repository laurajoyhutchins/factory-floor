import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create or replace function sync_attempt_delivery_lease()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.status in ('leased', 'running')
        and new.lease_token is not null
        and new.lease_expires_at is not null
        and (
          new.lease_expires_at is distinct from old.lease_expires_at
          or new.lease_owner is distinct from old.lease_owner
          or new.status is distinct from old.status
        )
      then
        update deliveries as delivery
        set
          status = 'leased',
          lease_owner = new.lease_owner,
          lease_token = new.lease_token,
          lease_expires_at = new.lease_expires_at
        from execution_inputs as input
        where input.execution_id = new.execution_id
          and input.delivery_id = delivery.id
          and delivery.status = 'leased'
          and delivery.lease_token = new.lease_token;
      end if;
      return new;
    end;
    $$;

    drop trigger if exists execution_attempts_sync_delivery_lease
      on execution_attempts;
    create trigger execution_attempts_sync_delivery_lease
      after update of status, lease_owner, lease_expires_at
      on execution_attempts
      for each row
      execute function sync_attempt_delivery_lease();

    update deliveries as delivery
    set
      lease_owner = attempt.lease_owner,
      lease_token = attempt.lease_token,
      lease_expires_at = attempt.lease_expires_at
    from execution_inputs as input
    join execution_attempts as attempt
      on attempt.execution_id = input.execution_id
    where input.delivery_id = delivery.id
      and delivery.status = 'leased'
      and attempt.status in ('leased', 'running')
      and attempt.lease_token = delivery.lease_token
      and attempt.lease_expires_at is not null
      and (
        delivery.lease_expires_at is null
        or delivery.lease_expires_at < attempt.lease_expires_at
      );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop trigger if exists execution_attempts_sync_delivery_lease
      on execution_attempts;
    drop function if exists sync_attempt_delivery_lease();
  `.execute(db);
}
