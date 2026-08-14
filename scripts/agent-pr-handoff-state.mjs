import {
  REPOSITORY_VERIFICATION_WORKFLOW,
  readReviewThreadState,
  resolvePullRequestState,
  selectAuthoritativeWorkflowRun,
  selectPullNumbersForEvent,
} from './github-pr-state.mjs';

export {
  readReviewThreadState,
  resolvePullRequestState,
  selectPullNumbersForEvent,
};

export const selectRepositoryVerificationRun = (runs, headSha, pullNumber) =>
  selectAuthoritativeWorkflowRun(runs, {
    workflowName: REPOSITORY_VERIFICATION_WORKFLOW,
    headSha,
    pullNumber,
  });

const BLOCKING_MERGEABLE_STATES = new Set([
  'blocked',
  'behind',
  'dirty',
  'draft',
  'unknown',
]);

export const determineHandoffState = ({
  draft,
  verificationRun,
  reviewThreads,
  mergeable,
  mergeableState,
}) => {
  if (draft) {
    return { state: 'implementing', externalBlocker: null };
  }

  if (!verificationRun || verificationRun.status !== 'completed') {
    return { state: 'awaiting-ci', externalBlocker: null };
  }

  if (verificationRun.conclusion !== 'success') {
    return {
      state: 'needs-attention',
      externalBlocker: 'repository-verification-failed',
    };
  }

  if (reviewThreads.status !== 'available') {
    return {
      state: 'needs-attention',
      externalBlocker: 'review-state-unavailable',
    };
  }

  if (reviewThreads.unresolvedCount > 0) {
    return { state: 'review', externalBlocker: null };
  }

  if (
    mergeable !== true ||
    !mergeableState ||
    BLOCKING_MERGEABLE_STATES.has(mergeableState)
  ) {
    return {
      state: 'needs-attention',
      externalBlocker:
        mergeable === false
          ? 'pull-request-not-mergeable'
          : `mergeable-state:${mergeableState ?? 'unknown'}`,
    };
  }

  return { state: 'ready', externalBlocker: null };
};
