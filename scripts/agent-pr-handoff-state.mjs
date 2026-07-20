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
    return {
      state: 'implementing',
      externalBlocker: null,
      nextAction:
        'Complete implementation, run a fresh self-review, and verify the current head.',
    };
  }

  if (!verificationRun || verificationRun.status !== 'completed') {
    return {
      state: 'awaiting-ci',
      externalBlocker: null,
      nextAction:
        'Re-evaluate this handoff when Repository Verification completes for the current head.',
    };
  }

  if (verificationRun.conclusion !== 'success') {
    return {
      state: 'needs-attention',
      externalBlocker: 'repository-verification-failed',
      nextAction:
        'Address the first actionable error from the retained Repository Verification handoff artifact.',
    };
  }

  if (reviewThreads.status !== 'available') {
    return {
      state: 'needs-attention',
      externalBlocker: 'review-state-unavailable',
      nextAction:
        'Restore access to the complete review-thread state before treating this pull request as ready.',
    };
  }

  if (reviewThreads.unresolvedCount > 0) {
    return {
      state: 'review',
      externalBlocker: null,
      nextAction:
        'Resolve outstanding review threads, then re-run exact-head verification.',
    };
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
      nextAction:
        mergeableState === 'behind'
          ? 'Synchronize the pull-request branch with its base, then verify the new exact head.'
          : 'Resolve the GitHub mergeability blocker before treating this pull request as ready.',
    };
  }

  return {
    state: 'ready',
    externalBlocker: null,
    nextAction:
      'Perform the final independent review and merge according to AGENTS.md.',
  };
};
