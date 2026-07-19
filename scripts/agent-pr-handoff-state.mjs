const REPOSITORY_VERIFICATION_WORKFLOW = 'Repository Verification';

const runTimestamp = (run) => {
  const value = Date.parse(run.created_at ?? '');
  return Number.isFinite(value) ? value : 0;
};

export const selectRepositoryVerificationRun = (runs, headSha, pullNumber) =>
  runs
    .filter(
      (run) =>
        run.name === REPOSITORY_VERIFICATION_WORKFLOW &&
        run.event === 'pull_request' &&
        run.head_sha === headSha &&
        run.pull_requests?.some(
          (pullRequest) => pullRequest.number === pullNumber,
        ),
    )
    .sort((left, right) => {
      const timestampDifference = runTimestamp(right) - runTimestamp(left);
      if (timestampDifference !== 0) return timestampDifference;
      return Number(right.id ?? 0) - Number(left.id ?? 0);
    })[0] ?? null;

export const readReviewThreadState = async ({
  graphql,
  owner,
  repo,
  pullNumber,
}) => {
  let after = null;
  let unresolvedCount = 0;

  do {
    const data = await graphql(
      `
        query ($owner: String!, $repo: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                nodes {
                  isResolved
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `,
      { owner, repo, number: pullNumber, after },
    );
    const page = data.repository?.pullRequest?.reviewThreads;
    if (!page) {
      throw new Error('GitHub did not return pull-request review threads.');
    }
    unresolvedCount += page.nodes.filter((thread) => !thread.isResolved).length;
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo.hasNextPage && !after) {
      throw new Error('GitHub review-thread pagination omitted an end cursor.');
    }
  } while (after);

  return { status: 'available', unresolvedCount };
};

export const determineHandoffState = ({
  draft,
  verificationRun,
  reviewThreads,
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

  if (mergeableState !== 'clean') {
    return {
      state: 'needs-attention',
      externalBlocker: `mergeable-state:${mergeableState ?? 'unknown'}`,
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
