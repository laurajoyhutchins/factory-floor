import { describe, expect, it } from 'vitest';
import { ArtifactDomainError, decodeArtifactReconciliationCursor, encodeArtifactReconciliationCursor, isJsonMediaType } from '../src/index.js';

describe('artifact domain helpers', () => {
  it('classifies JSON media types narrowly', () => {
    expect(isJsonMediaType('application/json')).toBe(true);
    expect(isJsonMediaType('application/vnd.factory+json; charset=utf-8')).toBe(true);
    expect(isJsonMediaType('text/json')).toBe(false);
    expect(isJsonMediaType('application/octet-stream')).toBe(false);
  });

  it('round trips opaque reconciliation cursors and rejects malformed input', () => {
    const cursor = encodeArtifactReconciliationCursor({ blob: 'token' });
    expect(cursor).not.toContain('token');
    expect(decodeArtifactReconciliationCursor(cursor)).toEqual({ blob: 'token' });
    expect(() => decodeArtifactReconciliationCursor('not-json')).toThrow(ArtifactDomainError);
  });
});
