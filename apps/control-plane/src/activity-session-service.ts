import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createUuidV7, type Database, type Json } from '@factory-floor/db';

export interface ActivitySessionRequest {
  applicationId: string;
  instanceId: string;
  installationId: string;
  guildId?: string;
  channelId?: string;
  threadId?: string;
  launchId: string;
  principalId: string;
  adapter: string;
  boundRunId?: string;
  boundView?: Json;
}

export interface ActivitySessionResponse {
  sessionToken: string;
  expiresAt: Date;
  idleExpiresAt: Date;
}

interface ExistingBinding {
  id: string;
  installation_id: string;
  guild_id: string | null;
  channel_id: string | null;
  thread_id: string | null;
  bound_run_id: string | null;
  adapter: string;
  expires_at: Date;
  closed_at: Date | null;
}

const SESSION_TTL_MS = 3_600_000;
const IDLE_TTL_MS = 300_000;
const TOKEN_BYTES = 32;
const BINDING_TTL_MS = 7_200_000;

function optionalValue(value: string | undefined): string | null {
  return value ?? null;
}

function minimumDate(...dates: Date[]): Date {
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

function assertBindingMatches(
  existing: ExistingBinding,
  request: ActivitySessionRequest,
  now: Date,
): void {
  if (existing.closed_at) throw new ActivitySessionError('instance_closed');
  if (existing.expires_at <= now)
    throw new ActivitySessionError('instance_expired');

  const locationMatches =
    existing.installation_id === request.installationId &&
    existing.guild_id === optionalValue(request.guildId) &&
    existing.channel_id === optionalValue(request.channelId) &&
    existing.thread_id === optionalValue(request.threadId);
  const adapterMatches = existing.adapter === request.adapter;
  const runMatches =
    request.boundRunId === undefined ||
    existing.bound_run_id === request.boundRunId;

  if (!locationMatches || !adapterMatches || !runMatches)
    throw new ActivitySessionError('instance_binding_mismatch');
}

export class ActivitySessionService {
  constructor(private readonly db: Kysely<Database>) {}

  async createOrJoinSession(
    request: ActivitySessionRequest,
    now = new Date(),
  ): Promise<{ instanceBindingId: string; session: ActivitySessionResponse }> {
    const binding = await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('activity_instance_bindings')
        .selectAll()
        .where('application_id', '=', request.applicationId)
        .where('instance_id', '=', request.instanceId)
        .forUpdate()
        .executeTakeFirst();

      if (existing) {
        if (!existing.expires_at || !existing.adapter)
          throw new ActivitySessionError('instance_binding_invalid');
        assertBindingMatches(existing as ExistingBinding, request, now);
        const expiresAt = new Date(now.getTime() + BINDING_TTL_MS);
        await trx
          .updateTable('activity_instance_bindings')
          .set({ expires_at: expiresAt })
          .where('id', '=', existing.id)
          .execute();
        return { id: existing.id, expiresAt };
      }

      const bindingId = createUuidV7(now.getTime());
      const expiresAt = new Date(now.getTime() + BINDING_TTL_MS);
      const inserted = await trx
        .insertInto('activity_instance_bindings')
        .values({
          id: bindingId,
          application_id: request.applicationId,
          instance_id: request.instanceId,
          installation_id: request.installationId,
          guild_id: request.guildId ?? null,
          channel_id: request.channelId ?? null,
          thread_id: request.threadId ?? null,
          launch_id: request.launchId,
          installation_identifier: `${request.applicationId}:${request.installationId}`,
          bound_run_id: request.boundRunId ?? null,
          bound_view: request.boundView ?? {},
          principal_id: request.principalId,
          adapter: request.adapter,
          expires_at: expiresAt,
        })
        .onConflict((conflict) =>
          conflict.columns(['application_id', 'instance_id']).doNothing(),
        )
        .returning(['id', 'expires_at'])
        .executeTakeFirst();

      if (inserted?.expires_at)
        return { id: inserted.id, expiresAt: inserted.expires_at };

      const raced = await trx
        .selectFrom('activity_instance_bindings')
        .selectAll()
        .where('application_id', '=', request.applicationId)
        .where('instance_id', '=', request.instanceId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!raced.expires_at || !raced.adapter)
        throw new ActivitySessionError('instance_binding_invalid');
      assertBindingMatches(raced as ExistingBinding, request, now);
      const racedExpiresAt = new Date(now.getTime() + BINDING_TTL_MS);
      await trx
        .updateTable('activity_instance_bindings')
        .set({ expires_at: racedExpiresAt })
        .where('id', '=', raced.id)
        .execute();
      return { id: raced.id, expiresAt: racedExpiresAt };
    });

    const session = await this.createSession(
      binding.id,
      request.principalId,
      binding.expiresAt,
      now,
    );
    return { instanceBindingId: binding.id, session };
  }

  private async createSession(
    instanceBindingId: string,
    principalId: string,
    bindingExpiresAt: Date,
    now: Date,
  ): Promise<ActivitySessionResponse> {
    const sessionToken = randomBytes(TOKEN_BYTES).toString('hex');
    const digest = createHash('sha256').update(sessionToken).digest('hex');
    const expiresAt = minimumDate(
      new Date(now.getTime() + SESSION_TTL_MS),
      bindingExpiresAt,
    );
    const idleExpiresAt = minimumDate(
      new Date(now.getTime() + IDLE_TTL_MS),
      expiresAt,
    );

    if (expiresAt <= now || idleExpiresAt <= now)
      throw new ActivitySessionError('instance_expired');

    await this.db
      .insertInto('activity_sessions')
      .values({
        id: createUuidV7(now.getTime()),
        instance_binding_id: instanceBindingId,
        principal_id: principalId,
        token_digest: digest,
        expires_at: expiresAt,
        idle_expires_at: idleExpiresAt,
      })
      .execute();

    return { sessionToken, expiresAt, idleExpiresAt };
  }

  async refreshSession(
    sessionToken: string,
    now = new Date(),
  ): Promise<ActivitySessionResponse | null> {
    const digest = createHash('sha256').update(sessionToken).digest('hex');

    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('activity_sessions')
        .selectAll()
        .where('token_digest', '=', digest)
        .forUpdate()
        .executeTakeFirst();

      if (!existing || existing.revoked_at) return null;
      if (existing.expires_at <= now || existing.idle_expires_at <= now)
        return null;

      const binding = await trx
        .selectFrom('activity_instance_bindings')
        .select(['expires_at', 'closed_at'])
        .where('id', '=', existing.instance_binding_id)
        .executeTakeFirst();

      if (
        !binding?.expires_at ||
        binding.closed_at ||
        binding.expires_at <= now
      )
        return null;

      const replacementToken = randomBytes(TOKEN_BYTES).toString('hex');
      const replacementDigest = createHash('sha256')
        .update(replacementToken)
        .digest('hex');
      const idleExpiresAt = minimumDate(
        new Date(now.getTime() + IDLE_TTL_MS),
        existing.expires_at,
        binding.expires_at,
      );
      if (idleExpiresAt <= now) return null;

      const updated = await trx
        .updateTable('activity_sessions')
        .set({
          token_digest: replacementDigest,
          idle_expires_at: idleExpiresAt,
          refreshed_at: now,
        })
        .where('id', '=', existing.id)
        .where('token_digest', '=', digest)
        .returning('id')
        .executeTakeFirst();
      if (!updated) return null;

      return {
        sessionToken: replacementToken,
        expiresAt: existing.expires_at,
        idleExpiresAt,
      };
    });
  }

  async revokeSession(
    sessionToken: string,
    now = new Date(),
  ): Promise<boolean> {
    const digest = createHash('sha256').update(sessionToken).digest('hex');
    const result = await this.db
      .updateTable('activity_sessions')
      .set({ revoked_at: now })
      .where('token_digest', '=', digest)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return result.numUpdatedRows > 0n;
  }

  async closeInstance(
    applicationId: string,
    instanceId: string,
    now = new Date(),
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const binding = await trx
        .updateTable('activity_instance_bindings')
        .set({ closed_at: now })
        .where('application_id', '=', applicationId)
        .where('instance_id', '=', instanceId)
        .where('closed_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!binding) return false;

      await trx
        .updateTable('activity_sessions')
        .set({ revoked_at: now })
        .where('instance_binding_id', '=', binding.id)
        .where('revoked_at', 'is', null)
        .execute();
      return true;
    });
  }
}

export class ActivitySessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivitySessionError';
  }
}
