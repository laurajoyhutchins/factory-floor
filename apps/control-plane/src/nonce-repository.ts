import { sql, type Kysely } from 'kysely';
import { createUuidV7, type Database } from '@factory-floor/db';

const NONCE_RETENTION_MS = 300_000;
const NONCE_CLEANUP_INTERVAL_MS = 30_000;

export function createNonceRepository(db: Kysely<Database>) {
  let lastCleanupAt = 0;

  return {
    async consumeNonce(
      keyId: string,
      nonce: string,
      now = Date.now(),
    ): Promise<boolean> {
      const inserted = await db
        .insertInto('service_request_nonces')
        .values({
          id: createUuidV7(now),
          key_id: keyId,
          nonce,
        })
        .onConflict((conflict) =>
          conflict.columns(['key_id', 'nonce']).doNothing(),
        )
        .returning('id')
        .executeTakeFirst();

      if (!inserted) return false;

      if (now - lastCleanupAt >= NONCE_CLEANUP_INTERVAL_MS) {
        lastCleanupAt = now;
        try {
          const cutoff = new Date(now - NONCE_RETENTION_MS);
          await sql`
            delete from service_request_nonces
            where created_at < ${cutoff}
          `.execute(db);
        } catch {
          // Cleanup is best effort; the unique insert already consumed the nonce.
        }
      }

      return true;
    },
  };
}
