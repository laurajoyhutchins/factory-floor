import { describe, expect, it } from 'vitest';

import { parseReviewClearance } from './review-clearance-state.mjs';

const HEAD_SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);

function evidence({
  sha = HEAD_SHA,
  ownerImpact = 'none',
  reviewThreads = '0',
} = {}) {
  return `<!-- integration-evidence:v1 -->\n\nHead: \`${sha}\`\nVerification: Repository Verification passed for this exact head.\nReview threads: ${reviewThreads}\nOwner impact: ${ownerImpact}\nProvenance: agent:integration-worker\nLimitations: Exact head only.`;
}

function delegatedComment(body = evidence(), association = 'COLLABORATOR') {
  return {
    id: 1,
    user: { login: 'scheduled-worker' },
    author_association: association,
    body,
    created_at: '2026-08-13T14:00:00Z',
  };
}

describe('integration evidence', () => {
  it('accepts exact-head delegated evidence with no owner impact', () => {
    expect(
      parseReviewClearance({
        comments: [delegatedComment()],
        ownerLogin: 'laurajoyhutchins',
        headSha: HEAD_SHA,
      }),
    ).toMatchObject({
      state: 'cleared',
      reviewedHead: HEAD_SHA,
      commentId: 1,
      ownerImpact: 'none',
      provenance: 'agent:integration-worker',
    });
  });

  it('rejects self-asserted delegated evidence from an untrusted actor', () => {
    expect(
      parseReviewClearance({
        comments: [delegatedComment(evidence(), 'NONE')],
        ownerLogin: 'laurajoyhutchins',
        headSha: HEAD_SHA,
      }),
    ).toMatchObject({ state: 'missing', commentId: null });
  });

  it('rejects evidence with material owner impact', () => {
    expect(
      parseReviewClearance({
        comments: [
          delegatedComment(evidence({ ownerImpact: 'timeline' })),
        ],
        ownerLogin: 'laurajoyhutchins',
        headSha: HEAD_SHA,
      }),
    ).toMatchObject({
      state: 'not-cleared',
      commentId: 1,
      ownerImpact: 'timeline',
    });
  });

  it('rejects evidence with unresolved review threads', () => {
    expect(
      parseReviewClearance({
        comments: [delegatedComment(evidence({ reviewThreads: '1' }))],
        ownerLogin: 'laurajoyhutchins',
        headSha: HEAD_SHA,
      }),
    ).toMatchObject({ state: 'not-cleared', commentId: 1 });
  });

  it('treats evidence for another head as stale', () => {
    expect(
      parseReviewClearance({
        comments: [delegatedComment(evidence({ sha: OLD_SHA }))],
        ownerLogin: 'laurajoyhutchins',
        headSha: HEAD_SHA,
      }),
    ).toMatchObject({ state: 'stale', reviewedHead: OLD_SHA });
  });
});
