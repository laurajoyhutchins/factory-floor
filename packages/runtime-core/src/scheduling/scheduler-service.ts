/* eslint-disable @typescript-eslint/no-explicit-any */
import { sql, type Kysely, type Transaction } from 'kysely';
import { createUuidV7, type Database } from '@factory-floor/db';
import { inputSetDigest, type InputIdentity } from '../commands/identity.js';
import { generateLeaseToken, validateLeaseDuration } from './lease.js';
import type {
  ComponentSelector,
  LeaseToken,
  WorkerId,
} from '../terminology.js';

const CANDIDATE_GROUP_LIMIT = 50;
const INCOMPLETE_GROUP_RECHECK_MS = 250;

export interface LeaseNextAttemptOptions {
  workerId: WorkerId | string;
  leaseDurationMs: number;
  componentSelectors?: readonly (ComponentSelector | string)[];
}
/** @deprecated Use LeaseNextAttemptOptions. */
export interface PollForExecutionOptions {
  owner: string;
  leaseDurationMs: number;
  capabilities?: readonly string[];
}
export interface LeasedExecutionAttempt {
  executionId: string;
  attemptId: string;
  attemptNumber: number;
  leaseToken: LeaseToken | string;
  leaseExpiresAt: string;
  inputs: { portName: string; deliveryId: string; payload: unknown }[];
}

/** @deprecated Use ExecutionLeaseService. */
export type ScheduledAttempt = LeasedExecutionAttempt;

export class ExecutionLeaseService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock = () => new Date(),
  ) {}

  async leaseNextAttempt(
    options: LeaseNextAttemptOptions,
  ): Promise<LeasedExecutionAttempt | null> {
    validateLeaseDuration(options.leaseDurationMs);
    if (
      options.componentSelectors !== undefined &&
      options.componentSelectors.length === 0
    )
      return null;
    const now = this.clock();
    const requestedLeaseExpiresAt = new Date(
      now.getTime() + options.leaseDurationMs,
    );
    const componentSelectorPredicate =
      options.componentSelectors === undefined
        ? sql<boolean>`true`
        : sql<boolean>`concat(cd.name, '@', cd.version) in (${sql.join(
            options.componentSelectors.map(
              (componentSelector) => sql`${componentSelector}`,
            ),
          )})`;

    return this.db.transaction().execute(async (trx) => {
      const candidates = await sql<any>`
        select candidate.*
        from (
          select
            d.*,
            row_number() over (
              partition by
                d.region_id,
                d.topology_revision_id,
                d.target_component_instance_id,
                d.correlation_id
              order by d.available_at, d.created_at, d.id
            ) as group_rank
          from deliveries d
          join component_instances ci on ci.id = d.target_component_instance_id
          join component_definitions cd on cd.id = ci.component_definition_id
          where d.status = 'ready'
            and d.available_at <= ${now}
            and ${componentSelectorPredicate}
        ) candidate
        where candidate.group_rank = 1
        order by candidate.available_at, candidate.created_at, candidate.id
        limit ${CANDIDATE_GROUP_LIMIT}
      `
        .execute(trx as any)
        .then((result) => result.rows);

      for (const candidate of candidates) {
        const scheduled = await this.tryCandidate(
          trx,
          candidate,
          options,
          now,
          requestedLeaseExpiresAt,
        );
        if (scheduled) return scheduled;
      }
      return null;
    });
  }

  private async tryCandidate(
    trx: Transaction<Database>,
    candidate: any,
    options: LeaseNextAttemptOptions,
    now: Date,
    requestedLeaseExpiresAt: Date,
  ): Promise<LeasedExecutionAttempt | null> {
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

    const deferGroup = async () => {
      await trx
        .updateTable('deliveries')
        .set({
          available_at: new Date(
            now.getTime() + INCOMPLETE_GROUP_RECHECK_MS,
          ) as any,
        })
        .where('status', '=', 'ready')
        .where('region_id', '=', candidate.region_id)
        .where('topology_revision_id', '=', candidate.topology_revision_id)
        .where(
          'target_component_instance_id',
          '=',
          candidate.target_component_instance_id,
        )
        .where('correlation_id', '=', candidate.correlation_id)
        .where('available_at', '<=', now as any)
        .execute();
    };

    const region = await trx
      .selectFrom('regions')
      .selectAll()
      .where('id', '=', candidate.region_id)
      .executeTakeFirstOrThrow();
    if (region.lifecycle_status !== 'running') {
      await deferGroup();
      return null;
    }
    const component = await trx
      .selectFrom('component_instances')
      .selectAll()
      .where('id', '=', candidate.target_component_instance_id)
      .executeTakeFirstOrThrow();
    const revision = await trx
      .selectFrom('topology_revisions')
      .select('topology')
      .where('id', '=', candidate.topology_revision_id)
      .executeTakeFirstOrThrow();
    const fanInExpected = new Map<string, number>();
    const fanInRules =
      (revision.topology as any)?.spec?.fanIn ??
      (revision.topology as any)?.fanIn ??
      [];
    if (Array.isArray(fanInRules))
      for (const rule of fanInRules) {
        const [instance, port] = String(rule.input ?? '').split('.');
        if (instance === component.name) {
          const expected = Number(rule.completion?.expected);
          if (Number.isInteger(expected) && expected > 0)
            fanInExpected.set(port, expected);
        }
      }
    const ports = await trx
      .selectFrom('port_definitions')
      .selectAll()
      .where('component_definition_id', '=', component.component_definition_id)
      .where('direction', '=', 'input')
      .orderBy('name')
      .execute();
    if (!ports.some((port) => port.name === candidate.target_port_name)) {
      await deferGroup();
      return null;
    }

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
      const expected = fanInExpected.get(port.name) ?? 1;
      if (rows.length !== expected) {
        await deferGroup();
        return null;
      }
      selected.push(...rows);
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
    const optionalByPort = new Map<string, any[]>();
    for (const delivery of optional) {
      const expected = fanInExpected.get(delivery.target_port_name) ?? 1;
      const deliveries = optionalByPort.get(delivery.target_port_name) ?? [];
      deliveries.push(delivery);
      if (deliveries.length > expected) {
        await deferGroup();
        return null;
      }
      optionalByPort.set(delivery.target_port_name, deliveries);
    }
    for (const [port, deliveries] of optionalByPort)
      if (deliveries.length === (fanInExpected.get(port) ?? 1))
        selected.push(...deliveries);
    if (selected.length === 0) {
      await deferGroup();
      return null;
    }
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
      .where(
        'component_instance_id',
        '=',
        candidate.target_component_instance_id,
      )
      .where('topology_revision_id', '=', candidate.topology_revision_id)
      .where('lifecycle_epoch', '=', region.lifecycle_epoch)
      .where('input_set_digest', '=', digest)
      .executeTakeFirst();
    if (execution && execution.status !== 'running') {
      await deferGroup();
      return null;
    }
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
      .where('status', '=', 'pending')
      .where((eb) =>
        eb.or([eb('started_at', 'is', null), eb('started_at', '<=', now)]),
      )
      .orderBy('attempt_number', 'asc')
      .forUpdate()
      .executeTakeFirst();
    if (!attempt) {
      const existing = await trx
        .selectFrom('execution_attempts')
        .selectAll()
        .where('execution_id', '=', execution.id)
        .orderBy('attempt_number', 'desc')
        .executeTakeFirst();
      if (existing) {
        await deferGroup();
        return null;
      }
      attempt = await trx
        .insertInto('execution_attempts')
        .values({
          id: createUuidV7(),
          execution_id: execution.id,
          attempt_number: 1,
          status: 'leased',
          lease_owner: String(options.workerId),
          lease_token: generateLeaseToken(),
          lease_expires_at: requestedLeaseExpiresAt,
          started_at: now,
        } as any)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else
      attempt = await trx
        .updateTable('execution_attempts')
        .set({
          status: 'leased',
          lease_owner: String(options.workerId),
          lease_token: generateLeaseToken(),
          lease_expires_at: requestedLeaseExpiresAt,
          started_at: now,
        })
        .where('id', '=', attempt.id)
        .returningAll()
        .executeTakeFirstOrThrow();

    await trx
      .updateTable('deliveries')
      .set({
        status: 'leased',
        lease_owner: String(options.workerId),
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
      attemptNumber: attempt.attempt_number,
      leaseToken: attempt.lease_token!,
      leaseExpiresAt: attempt.lease_expires_at!.toISOString(),
      inputs: selected.map((delivery) => ({
        portName: delivery.target_port_name,
        deliveryId: delivery.id,
        payload: delivery.input_payload,
      })),
    };
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

/** @deprecated Use ExecutionLeaseService. */
export class SchedulerService extends ExecutionLeaseService {
  /** @deprecated Use leaseNextAttempt({ workerId, componentSelectors }). */
  pollForExecution(
    options: PollForExecutionOptions,
  ): Promise<LeasedExecutionAttempt | null> {
    return this.leaseNextAttempt({
      workerId: options.owner,
      leaseDurationMs: options.leaseDurationMs,
      componentSelectors: options.capabilities,
    });
  }
}
