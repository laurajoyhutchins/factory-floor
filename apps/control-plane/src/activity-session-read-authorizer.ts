import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '@factory-floor/db';

export interface ActivityReadSession {
  sessionId: string;
  instanceBindingId: string;
  applicationId: string;
  instanceId: string;
  installationId: string;
  guildId: string | null;
  channelId: string | null;
  threadId: string | null;
  principalId: string;
  adapter: string;
  boundRunId: string | null;
  expiresAt: Date;
  idleExpiresAt: Date;
}

export interface ActivitySessionAuthorizer {
  resolveSession(
    sessionToken: string,
    now?: Date,
  ): Promise<ActivityReadSession | null>;
}

export class DatabaseActivitySessionAuthorizer
  implements ActivitySessionAuthorizer
{
  constructor(private readonly db: Kysely<Database>) {}

  async resolveSession(
    sessionToken: string,
    now = new Date(),
  ): Promise<ActivityReadSession | null> {
    const token = sessionToken.trim();
    if (!token) return null;
    const digest = createHash('sha256').update(token).digest('hex');
    const row = await this.db
      .selectFrom('activity_sessions as session')
      .innerJoin(
        'activity_instance_bindings as binding',
        'binding.id',
        'session.instance_binding_id',
      )
      .select([
        'session.id as session_id',
        'session.instance_binding_id',
        'session.principal_id',
        'session.expires_at as session_expires_at',
        'session.idle_expires_at',
        'session.revoked_at',
        'binding.application_id',
        'binding.instance_id',
        'binding.installation_id',
        'binding.guild_id',
        'binding.channel_id',
        'binding.thread_id',
        'binding.adapter',
        'binding.bound_run_id',
        'binding.expires_at as binding_expires_at',
        'binding.closed_at',
      ])
      .where('session.token_digest', '=', digest)
      .executeTakeFirst();

    if (
      !row ||
      row.revoked_at ||
      row.closed_at ||
      row.session_expires_at <= now ||
      row.idle_expires_at <= now ||
      !row.binding_expires_at ||
      row.binding_expires_at <= now
    )
      return null;

    return {
      sessionId: row.session_id,
      instanceBindingId: row.instance_binding_id,
      applicationId: row.application_id,
      instanceId: row.instance_id,
      installationId: row.installation_id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      threadId: row.thread_id,
      principalId: row.principal_id,
      adapter: row.adapter ?? 'discord-agent',
      boundRunId: row.bound_run_id,
      expiresAt: row.session_expires_at,
      idleExpiresAt: row.idle_expires_at,
    };
  }
}
