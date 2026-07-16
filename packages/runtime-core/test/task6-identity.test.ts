import { describe, expect, it } from 'vitest';
import {
  commandRequestDigest,
  inputSetDigest,
  payloadDigest,
  generateLeaseToken,
} from '../src/index.js';

describe('Task 6 identity helpers', () => {
  it('computes stable command request digests and includes semantic fields', () => {
    const base = {
      region: '/investigation',
      commandType: 'investigation.start',
      source: { kind: 'user', subject: 'a' },
      payload: { objective: 'x' },
      correlationId: 'c',
      expiresAt: '2026-07-16T00:00:00.000Z',
    };
    expect(commandRequestDigest(base)).toBe(
      commandRequestDigest({ ...base, payload: { objective: 'x' } }),
    );
    expect(commandRequestDigest(base)).not.toBe(
      commandRequestDigest({ ...base, correlationId: 'other' }),
    );
  });
  it('preserves array order in payload digests', () => {
    expect(payloadDigest({ a: [1, 2] })).not.toBe(payloadDigest({ a: [2, 1] }));
  });
  it('makes input-set digest independent of discovery order', () => {
    const a = {
      portName: 'b',
      deliveryId: '2',
      sourceKind: 'command' as const,
      sourceId: 'c',
      payloadDigest: 'b'.repeat(64),
    };
    const b = {
      portName: 'a',
      deliveryId: '1',
      sourceKind: 'event' as const,
      sourceId: 'e',
      payloadDigest: 'a'.repeat(64),
    };
    expect(inputSetDigest([a, b])).toBe(inputSetDigest([b, a]));
  });
  it('generates opaque 256-bit lease tokens', () => {
    const token = generateLeaseToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(generateLeaseToken()).not.toBe(token);
  });
});
