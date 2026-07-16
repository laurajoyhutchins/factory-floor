import { describe, expect, it } from 'vitest';
import { appendDeduped } from './liveEvents.js';
describe('live event buffer', () => {
  it('deduplicates and bounds newest-first events', () => {
    const out = appendDeduped(
      [{ id: 'a' }],
      [{ id: 'b' }, { id: 'a' }, { id: 'c' }],
      2,
    );
    expect(out.map((e) => e.id)).toEqual(['c', 'b']);
  });
});
