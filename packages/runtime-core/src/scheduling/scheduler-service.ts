/* eslint-disable @typescript-eslint/no-explicit-any */
import { sql, type Kysely } from 'kysely';
import { createUuidV7, type Database } from '@factory-floor/db';
import { inputSetDigest, type InputIdentity } from '../commands/identity.js';
import { generateLeaseToken, validateLeaseDuration } from './lease.js';

export interface PollForExecutionOptions {
  owner: string;
  leaseDurationMs: number;
  capabilities?: readonly string[];
}
export interface ScheduledAttempt {
  executionId: string;
  attemptId: string;
  attemptNumber: number;
  leaseToken: string;
  leaseExpiresAt: string;
  inputs: { portName: string; deliveryId: string; payload: unknown }[];
}

export class SchedulerService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock = () => new Date(),
  ) {}

  async pollForExecution(
    options: PollForExecutionOptions,
  ): Promise<ScheduledAttempt | null> {
    validateLeaseDuration(options.leaseDurationMs);
    if (options.capabilities !== undefined && options.capabilities.length === 0)
      return null;
    const now = this.clock();
    const requestedLeaseExpiresAt = new Date(
      now.getTime() + options.leaseDurationMs,
    );
    const requestedLeaseToken = generateLeaseToken();
    const capabilityPredicate =
      options.capabilities === undefined
        ? sql<boolean>`true`
        : sql<boolean>`concat(cd.name, '@', cd.version) = any(${[
            ...options.capabilities,
          ]}::text[])`;

    return this.db.transaction().execute(async (trx) => {
      const candidate = await sql<any>`
        select d.*
        from deliveries d
        join component_instances ci on ci.id = d.target_component_instance_id
        join component_definitions cd on cd.id = ci.component_definition_id
        where d.status = 'ready'
          and d.available_at <= ${now}
          and ${capabilityPredicate}
        order by d.available_at, d.created_at, d.id
        limit 1
      `
        .execute(trx as any)
        .then((result) => result.rows[0]);
      if (!candidate) return null;

      const groupKey = [
        candidate.region_id,
        candidate.topology_revision_id,
        candidate.target_component_instance_id,
        candidate.correlation_id,
      ].join(':');
      const groupLock = await sql<{ acquired: boolean }>`
        select pg_try_advisory_xact_lock(
          hashtextextended(${groupKey}, 0)
        ) as acquired
      `
        .execute(trx as any)
        .then((result) => result.rows[0]);
      if (!groupLock.acquired) return null;

      const region = await trx
        .selectFrom('regions')
        .selectAll()
        .where('id', '=', candidate.region_id)
        .executeTakeFirstOrThrow();
      const component = await trx
        .selectFrom('component_instances')
        .selectAll()
        .where('id', '=', candidate.target_component_instance_id)
        .executeTakeFirstOrThrow();
      const ports = await trx
        .selectFrom('port_definitions')
        .selectAll()
        .where('component_definition_id', '=', component.component_definition_id)
        .where('direction', '=', 'input')
        .orderBy('name')
        .execute();
      if (!ports.some((port) => port.name === candidate.target_port_name))
        throw new Error(
          `delivery targets undeclared input port ${candidate.target_port_name}`,
        );

      const selected: any[] = [];
      for (const port of ports.filter((item) => item.required)) {
        const rows = await sql<any>`
          select *
          from deliveries
          where status = 'ready'
            and region_id = ${candidate.region_id}
            and topology_revision_id = ${candidate.topology_revision_id}
            and target_component_instance_id = ${candidate.target_component_instance_id}
            and correlation_id = ${candidate.correlation_id}
            and target_port_name = ${port.name}
            and available_at <= ${now}
          order by created_at, id
          for update
        `
          .execute(trx as any)
          .then((result) => result.rows);
        if (rows.length === 0) return null;
        if (rows.length > 1)
          throw new Error(`ambiguous duplicate deliveries for port ${port.name}`);
        selected.push(rows[0]);
      }

      const optional = await sql<any>`
        select d.*
        from deliveries d
        join port_definitions p
          on p.component_definition_id = ${component.component_definition_id}
          and p.name = d.target_port_name
          and p.direction = 'input'
          and p.required = false
        where d.status = 'ready'
          and d.region_id = ${candidate.region_id}
          and d.topology_revision_id = ${candidate.topology_revision_id}
          and d.target_component_instance_id = ${candidate.target_component_instance_id}
          and d.correlation_id = ${candidate.correlation_id}
          and d.available_at <= ${now}
        order by d.target_port_name, d.created_at, d.id
        for update of d
      `
        .execute(trx as any)
        .then((result) => result.rows);
      const optionalByPort = new Map<string, any>();
      for (const delivery of optional) {
        if (optionalByPort.has(delivery.target_port_name))
          throw new Error(
            `ambiguous duplicate deliveries for port ${delivery.target_port_name}`,
          );
        optionalByPort.set(delivery.target_port_name, delivery);
      }
      selected.push(...optionalByPort.values());
      if (selected.length === 0)
        throw new Error('scheduler selected an empty input set');
      selected.sort(
        (left, right) =>
          String(left.target_port_name).localeCompare(
            String(right.target_port_name),
          ) || String(left.id).localeCompare(String(right.id)),
      );

      const identities: InputIdentity[] = selected.map((delivery) => ({
        portName: delivery.target_port_name,
        deliveryId: delivery.id,
        sourceKind: delivery.source_command_id ? 'command' : 'event',
        sourceId: delivery.source_command_id ?? delivery.source_event_id,
        payloadDigest: delivery.input_payload_digest,
      }));
      const digest = inputSetDigest(identities);
      const trigger = [...selected].sort((left, right) =>
        String(left.id).localeCompare(String(right.id)),
      )[0];

      let execution = await trx
        .selectFrom('executions')
        .selectAll()
        .where('region_id', '=', candidate.region_id)
        .where('component_instance_id', '=', candidate.target_component_instance_id)
        .where('topology_revision_id', '=', candidate.topology_revision_id)
        .where('lifecycle_epoch', '=', region.lifecycle_epoch)
        .where('input_set_digest', '=', digest)
        .executeTakeFirst();
      if (!execution)
        execution = await trx
          .insertInto('executions')
          .values({
            id: createUuidV7(),
            delivery_id: trigger.id,
            region_id: candidate.region_id,
            component_instance_id: candidate.target_component_instance_id,
            topology_revision_id: candidate.topology_revision_id,
            lifecycle_epoch: region.lifecycle_epoch,
            input_set_digest: digest,
            status: 'running',
          } as any)
          .returningAll()
          .executeTakeFirstOrThrow();

      for (const delivery of selected)
        await trx
          .insertInto('execution_inputs')
          .values({
            id: createUuidV7(),
            execution_id: execution.id,
            port_name: delivery.target_port_name,
            delivery_id: delivery.id,
            payload: delivery.input_payload,
          } as any)
          .onConflict((conflict) =>
            conflict
              .columns(['execution_id', 'port_name', 'delivery_id'])
              .doNothing(),
          )
          .execute();

      let attempt = await trx
        .selectFrom('execution_attempts')
        .selectAll()
        .where('execution_id', '=', execution.id)
        .where('attempt_number', '=', 1)
        .executeTakeFirst();
      if (!attempt)
        attempt = await trx
          .insertInto('execution_attempts')
          .values({
            id: createUuidV7(),
            execution_id: execution.id,
            attempt_number: 1,
            status: 'leased',
            lease_owner: options.owner,
            lease_token: requestedLeaseToken,
            lease_expires_at: requestedLeaseExpiresAt,
            started_at: now,
          } as any)
          .returningAll()
          .executeTakeFirstOrThrow();
      else if (attempt.status === 'pending')
        attempt = await trx
          .updateTable('execution_attempts')
          .set({
            status: 'leased',
            lease_owner: options.owner,
            lease_token: requestedLeaseToken,
            lease_expires_at: requestedLeaseExpiresAt,
            started_at: now,
          })
          .where('id', '=', attempt.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      else
        throw new Error(
          `logical execution ${execution.id} already has attempt 1 in status ${attempt.status}`,
        );

      await trx
        .updateTable('deliveries')
        .set({
          status: 'leased',
          lease_owner: options.owner,
          lease_token: attempt.lease_token,
          lease_expires_at: attempt.lease_expires_at,
          attempts_count: sql`attempts_count + 1` as any,
        })
        .where(
          'id',
          'in',
          selected.map((delivery) => delivery.id),
        )
        .execute();

      return {
        executionId: execution.id,
        attemptId: attempt.id,
        attemptNumber: 1,
        leaseToken: attempt.lease_token!,
        leaseExpiresAt: attempt.lease_expires_at!.toISOString(),
        inputs: selected.map((delivery) => ({
          portName: delivery.target_port_name,
          deliveryId: delivery.id,
          payload: delivery.input_payload,
        })),
      };
    });
  }

  listExpiredLeases(now = this.clock()) {
    return this.db
      .selectFrom('execution_attempts')
      .selectAll()
      .where('status', 'in', ['leased', 'running'])
      .where('lease_expires_at', '<', now)
      .execute();
  }
}
