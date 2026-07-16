import { describe, expect, it } from 'vitest';
import { appendDeduped, parseSseBatch } from './liveEvents.js';

describe('live event buffer', () => {
  it('deduplicates and bounds newest-first events', () => {
    const out = appendDeduped(
      [{ id: 'a' }],
      [{ id: 'b' }, { id: 'a' }, { id: 'c' }],
      2,
    );
    expect(out.map((event) => event.id)).toEqual(['c', 'b']);
  });

  it('parses runtime summaries and preserves the opaque checkpoint cursor', () => {
    const batch = parseSseBatch(
      [
        'id: event-cursor',
        'event: runtime-summary',
        'data: {"id":"event-1","event_type":"completed"}',
        '',
        'event: checkpoint',
        'data: {"nextCursor":"opaque-next=="}',
        '',
      ].join('\n'),
    );
    expect(batch.events).toEqual([
      { id: 'event-1', event_type: 'completed' },
    ]);
    expect(batch.cursor).toBe('opaque-next==');
  });
});
