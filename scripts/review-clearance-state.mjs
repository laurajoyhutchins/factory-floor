import {
  determineVerificationStatus,
  readReviewThreadState,
  resolvePullRequestState,
  selectAuthoritativeWorkflowRun,
  selectPullNumbersForEvent,
} from './github-pr-state.mjs';

export {
  determineVerificationStatus,
  readReviewThreadState,
  resolvePullRequestState,
  selectAuthoritativeWorkflowRun,
};
export const selectPullNumbersForClearanceEvent = selectPullNumbersForEvent;

export const REVIEW_CLEARANCE_MARKER = '<!-- review-clearance:v1 -->';

const REQUIRED_REVIEW_SECTIONS = [
  '## Final review',
  'Scope reviewed:',
  'Findings and changes:',
  'Verification:',
  'Remaining limitations:',
];

const timestamp = (value) => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const commentTimestamp = (comment) =>
  Math.max(timestamp(comment.updated_at), timestamp(comment.created_at));

const hasCompleteReviewRecord = (body) => {
  let offset = body.indexOf(REVIEW_CLEARANCE_MARKER);
  if (offset < 0) return false;

  for (const section of REQUIRED_REVIEW_SECTIONS) {
    offset = body.indexOf(section, offset + 1);
    if (offset < 0) return false;
  }

  return true;
};

export const parseReviewClearance = ({ comments, ownerLogin, headSha }) => {
  const latest = comments
    .filter(
      (comment) =>
        comment.user?.login === ownerLogin &&
        comment.body?.includes(REVIEW_CLEARANCE_MARKER),
    )
    .sort((left, right) => {
      const timeDifference = commentTimestamp(right) - commentTimestamp(left);
      if (timeDifference !== 0) return timeDifference;
      return Number(right.id ?? 0) - Number(left.id ?? 0);
    })[0];

  if (!latest) {
    return { state: 'missing', reviewedHead: null, commentId: null };
  }

  const reviewedHead = latest.body.match(
    /Reviewed head:\s*`([0-9a-f]{40})`/i,
  )?.[1];
  if (!reviewedHead || !hasCompleteReviewRecord(latest.body)) {
    return {
      state: 'not-cleared',
      reviewedHead: reviewedHead ?? null,
      commentId: latest.id,
    };
  }

  if (reviewedHead.toLowerCase() !== headSha.toLowerCase()) {
    return { state: 'stale', reviewedHead, commentId: latest.id };
  }

  const disposition = latest.body.match(
    /^Disposition:\s*(Cleared for merge\.|Not cleared for merge\.)\s*$/im,
  )?.[1];
  if (disposition?.toLowerCase() === 'cleared for merge.') {
    return { state: 'cleared', reviewedHead, commentId: latest.id };
  }

  return { state: 'not-cleared', reviewedHead, commentId: latest.id };
};

export const determineReviewClearanceStatus = ({
  draft,
  workflowRun,
  reviewThreads,
  clearance,
}) => {
  if (draft) {
    return {
      state: 'pending',
      description: 'Draft pull request; final review clearance is unavailable.',
    };
  }

  if (!workflowRun || workflowRun.status !== 'completed') {
    return {
      state: 'pending',
      description: 'Waiting for authoritative exact-head CI.',
    };
  }

  if (workflowRun.conclusion !== 'success') {
    return {
      state: 'failure',
      description: 'Authoritative exact-head CI did not pass.',
    };
  }

  if (reviewThreads?.status !== 'available') {
    return {
      state: 'error',
      description: 'Complete review-thread state is unavailable.',
    };
  }

  if (reviewThreads.unresolvedCount > 0) {
    return {
      state: 'failure',
      description: `${reviewThreads.unresolvedCount} review conversation(s) remain unresolved.`,
    };
  }

  if (clearance?.state === 'cleared') {
    return {
      state: 'success',
      description: 'Owner review cleared the exact current head for merge.',
    };
  }

  if (clearance?.state === 'stale') {
    return {
      state: 'pending',
      description: 'Review clearance does not match the current head SHA.',
    };
  }

  if (clearance?.state === 'not-cleared') {
    return {
      state: 'pending',
      description: 'Latest owner review decision does not clear this head.',
    };
  }

  return {
    state: 'pending',
    description: 'Waiting for an owner-authored final review clearance.',
  };
};
