import { describe, expect, it } from 'vitest';

import { parseReviewClearance } from './review-clearance-state.mjs';

const HEAD_SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);

function evidence({ sha = HEAD_SHA, ownerImpact = 'none', reviewThreads = '0' } = {}) {
  return `<!-- integration-evidence:v1 -->\n\nHead: \`${sha}\`\nVerification: Repository Verification passed for this exact head.\nReview threads: ${reviewThreads}\nOwner impact: ${ownerImpact}\nProvenance: agent:integration-worker\nLimitations: Exact head only.`;
}

describe('integration evidence', () => {
  it('accepts exact-head delegated evidence with no owner impact', () => {
    expect(parseReviewClearance({
      comments: [{ id: 1, user: { login: 'scheduled-worker' }, body: evidence(), created_at: '2026-08-13T14:00:00Z' }],
      ownerLogin: 'laurajoyhutchins',
      headSha: HEAD_SHA,
    })).toMatchObject({ state: 'cleared', reviewedHead: HEAD_SHA, commentId: 1, ownerImpact: 'none' });
  });

  it('rejects evidence with material owner impact', () => {
    expect(parseReviewClearance({
      comments: [{ id: 1, user: { login: 'scheduled-worker' }, body: evidence({ ownerImpact: 'timeline' }), created_at: '2026-08-13T14:00:00Z' }],
      ownerLogin: 'laurajoyhutchins',
      headSha: HEAD_SHA,
    })).toMatchObject({ state: 'not-cleared', commentId: 1 });
  });

  it('rejects evidence with unresolved review threads', () => {
    expect(parseReviewClearance({
      comments: [{ id: 1, user: { login: 'scheduled-worker' }, body: evidence({ reviewThreads: '1' }), created_at: '2026-08-13T14:00:00Z' }],
      ownerLogin: 'laurajoyhutchins',
      headSha: HEAD_SHA,
    })).toMatchObject({ state: 'not-cleared', commentId: 1 });
  });

  it('treats evidence for another head as stale', () => {
    expect(parseReviewClearance({
      comments: [{ id: 1, user: { login: 'scheduled-worker' }, body: evidence({ sha: OLD_SHA }), created_at: '2026-08-13T14:00:00Z' }],
      ownerLogin: 'laurajoyhutchins',
      headSha: HEAD_SHA,
    })).toMatchObject({ state: 'stale', reviewedHead: OLD_SHA });
  });
});
