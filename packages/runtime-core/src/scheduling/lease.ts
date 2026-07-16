import { randomBytes } from 'node:crypto';
export function generateLeaseToken(): string {
  return randomBytes(32).toString('base64url');
}
export function validateLeaseDuration(ms: number): void {
  if (!Number.isInteger(ms) || ms <= 0 || ms > 15 * 60_000)
    throw new Error('leaseDurationMs must be between 1ms and 15 minutes');
}
