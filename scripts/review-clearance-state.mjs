export const REVIEW_CLEARANCE_MARKER = '<!-- review-clearance:v1 -->';

const isPullNumber = (value) => Number.isInteger(value) && value > 0;

const eventPullNumber = (payload) => {
  const pullNumber = payload.pull_request?.number;
  return isPullNumber(pullNumber) ? [pullNumber] : [];
};

export const selectPullNumbersForClearanceEvent = ({ eventName, payload }) => {
  if (
    eventName === 'pull_request_target' ||
    eventName === 'pull_request_review' ||
    eventName === 'pull_request_review_comment'
  ) {
    return eventPullNumber(payload);
  }

  if (eventName === 'issue_comment') {
    const pullNumber = payload.issue?.pull_request
      ? payload.issue?.number
      : null;
    return isPullNumber(pullNumber) ? [pullNumber] : [];
  }

  if (eventName === 'workflow_run') {
    return [
      ...new Set(
        (payload.workflow_run?.pull_requests ?? [])
          .map((pullRequest) => pullRequest.number)
          .filter(isPullNumber),
      ),
    ];
  }

  return [];
};

const timestamp = (value) => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
};

export const selectAuthoritativeWorkflowRun = (
  runs,
  { workflowName, headSha, pullNumber },
) =>
  runs
    .filter(
      (run) =>
        run.name === workflowName &&
        run.event === 'pull_request' &&
        run.head_sha === headSha &&
        run.pull_requests?.some(
          (pullRequest) => pullRequest.number === pullNumber,
        ),
    )
    .sort((left, right) => {
      const timeDifference =
        timestamp(right.created_at) - timestamp(left.created_at);
      if (timeDifference !== 0) return timeDifference;
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
                nodes { isResolved }
                pageInfo { hasNextPage endCursor }
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

const commentTimestamp = (comment) =>
  Math.max(timestamp(comment.updated_at), timestamp(comment.created_at));

export const parseReviewClearance = ({ comments, ownerLogin, headSha }) => {
  const latest = comments
    .filter(
      (comment) =>
        comment.user?.login === ownerLogin &&
        comment.body?.includes(REVIEW_CLEARANCE_MARKER),
    )
    .sort((left, right) => {
      const timeDifference =
        commentTimestamp(right) - commentTimestamp(left);
      if (timeDifference !== 0) return timeDifference;
      return Number(right.id ?? 0) - Number(left.id ?? 0);
    })[0];

  if (!latest) {
    return { state: 'missing', reviewedHead: null, commentId: null };
  }

  const reviewedHead = latest.body.match(
    /Reviewed head:\s*`([0-9a-f]{40})`/i,
  )?.[1];
  if (!reviewedHead) {
    return {
      state: 'not-cleared',
      reviewedHead: null,
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
