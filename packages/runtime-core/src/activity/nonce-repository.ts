import { sql, type Kysely } from 'kysely';
import type { Database } from '@factory-floor/db';
import { createUuidV7 } from '@factory-floor/db';

export function createNonceRepository(db: Kysely<Database>) {
  const NONCE_CLEANUP_INTERVAL = 0.1;
  let lastCleanup = 0;

  return {
    async isNonceUsed(keyId: string, nonce: string): Promise<boolean> {
      const existing = await db
        .selectFrom('service_request_nonces')
        .select('id')
        .where('key_id', '=', keyId)
        .where('nonce', '=', nonce)
        .executeTakeFirst();
      return existing !== undefined;
    },

    async recordNonce(keyId: string, nonce: string): Promise<void> {
      await db
        .insertInto('service_request_nonces')
        .values({
          id: createUuidV7(),
          key_id: keyId,
          nonce,
        })
        .execute();

      const now = Date.now();
      if (now - lastCleanup > NONCE_CLEANUP_INTERVAL * 60_000) {
        lastCleanup = now;
        await db
          .deleteFrom('service_request_nonces')
          .where('created_at', '<', new Date(now - 300_000) as any)
          .execute();
      }
    },
  };
}
