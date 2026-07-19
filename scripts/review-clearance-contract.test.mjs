import { describe, expect, it } from 'vitest';

import { parseReviewClearance } from './review-clearance-state.mjs';

const HEAD_SHA = 'a'.repeat(40);

describe('review clearance durable record', () => {
  it('rejects a clearance marker without the complete review sections', () => {
    expect(
      parseReviewClearance({
        comments: [
          {
            id: 1,
            user: { login: 'laurajoyhutchins' },
            body: `<!-- review-clearance:v1 -->

Reviewed head: \`${HEAD_SHA}\`

Disposition: Cleared for merge.`,
            created_at: '2026-07-19T20:00:00Z',
            updated_at: '2026-07-19T20:00:00Z',
          },
        ],
        ownerLogin: 'laurajoyhutchins',
        headSha: HEAD_SHA,
      }),
    ).toMatchObject({ state: 'not-cleared', commentId: 1 });
  });
});
