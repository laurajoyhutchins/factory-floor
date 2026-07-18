import { createHash, randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { createUuidV7, type Database } from '@factory-floor/db';

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
}

export interface ActivitySessionResponse {
  sessionId: string;
  tokenDigest: string;
  expiresAt: Date;
  idleExpiresAt: Date;
}

const SESSION_TTL_MS = 3_600_000;
const IDLE_TTL_MS = 300_000;
const TOKEN_BYTES = 32;
const BINDING_TTL_MS = 7_200_000;

export class ActivitySessionService {
  constructor(private readonly db: Kysely<Database>) {}

  async createOrJoinSession(
    request: ActivitySessionRequest,
    now = new Date(),
  ): Promise<{ instanceBindingId: string; session: ActivitySessionResponse }> {
    const instanceBindingId = await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('activity_instance_bindings')
        .selectAll()
        .where('application_id', '=', request.applicationId)
        .where('instance_id', '=', request.instanceId)
        .executeTakeFirst();

      if (existing) {
        if (existing.closed_at)
          throw new ActivitySessionError('instance_closed');

        const principalChanged =
          existing.principal_id !== request.principalId;
        await trx
          .updateTable('activity_instance_bindings')
          .set({
            principal_id: request.principalId,
            adapter: request.adapter,
            ...(request.boundRunId !== undefined
              ? { bound_run_id: request.boundRunId }
              : {}),
            ...(principalChanged ? { bound_view: {} } : {}),
            expires_at: new Date(now.getTime() + BINDING_TTL_MS),
          })
          .where('id', '=', existing.id)
          .execute();

        return existing.id;
      }

      const bindingId = createUuidV7(now.getTime());
      const expiresAt = new Date(now.getTime() + BINDING_TTL_MS);
      const result = await trx
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
          bound_view: sql`'{}'::jsonb`,
          principal_id: request.principalId,
          adapter: request.adapter,
          expires_at: expiresAt as any,
          created_at: now as any,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      return result.id;
    });

    const session = await this.createSession(instanceBindingId, now);
    return { instanceBindingId, session };
  }

  private async createSession(
    instanceBindingId: string,
    now: Date,
  ): Promise<ActivitySessionResponse> {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const digest = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const idleExpiresAt = new Date(now.getTime() + IDLE_TTL_MS);

    const sessionId = createUuidV7(now.getTime());
    await this.db
      .insertInto('activity_sessions')
      .values({
        id: sessionId,
        instance_binding_id: instanceBindingId,
        token_digest: digest,
        expires_at: expiresAt as any,
        idle_expires_at: idleExpiresAt as any,
        created_at: now as any,
      })
      .execute();

    return {
      sessionId: token,
      tokenDigest: digest,
      expiresAt,
      idleExpiresAt,
    };
  }

  async refreshSession(
    sessionToken: string,
    now = new Date(),
  ): Promise<ActivitySessionResponse | null> {
    const digest = createHash('sha256').update(sessionToken).digest('hex');
    const existing = await this.db
      .selectFrom('activity_sessions')
      .selectAll()
      .where('token_digest', '=', digest)
      .executeTakeFirst();

    if (!existing) return null;
    if (existing.revoked_at) return null;
    if (existing.expires_at < now) return null;
    if (existing.idle_expires_at < now) return null;

    const binding = await this.db
      .selectFrom('activity_instance_bindings')
      .selectAll()
      .where('id', '=', existing.instance_binding_id)
      .executeTakeFirst();

    if (!binding || binding.closed_at) return null;

    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const idleExpiresAt = new Date(now.getTime() + IDLE_TTL_MS);

    const newToken = randomBytes(TOKEN_BYTES).toString('hex');
    const newDigest = createHash('sha256').update(newToken).digest('hex');

    await this.db
      .updateTable('activity_sessions')
      .set({
        token_digest: newDigest,
        expires_at: expiresAt,
        idle_expires_at: idleExpiresAt,
        refreshed_at: now,
      })
      .where('id', '=', existing.id)
      .execute();

    return {
      sessionId: newToken,
      tokenDigest: newDigest,
      expiresAt,
      idleExpiresAt,
    };
  }

  async revokeSession(sessionToken: string): Promise<boolean> {
    const digest = createHash('sha256').update(sessionToken).digest('hex');
    const result = await this.db
      .updateTable('activity_sessions')
      .set({ revoked_at: new Date() })
      .where('token_digest', '=', digest)
      .where('revoked_at', 'is', null)
      .execute();

    return result.length > 0 && result[0].numUpdatedRows > 0n;
  }

  async closeInstance(instanceId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('activity_instance_bindings')
      .set({ closed_at: new Date() })
      .where('instance_id', '=', instanceId)
      .where('closed_at', 'is', null)
      .execute();

    return result.length > 0 && result[0].numUpdatedRows > 0n;
  }
}

export class ActivitySessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivitySessionError';
  }
}
