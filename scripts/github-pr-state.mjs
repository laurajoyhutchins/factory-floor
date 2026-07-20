export const REPOSITORY_VERIFICATION_WORKFLOW = 'Repository Verification';

const DIRECT_PULL_REQUEST_EVENTS = new Set([
  'pull_request_target',
  'pull_request_review',
  'pull_request_review_comment',
]);

const isPullNumber = (value) => Number.isInteger(value) && value > 0;

export const selectPullNumbersForEvent = ({ eventName, payload }) => {
  if (DIRECT_PULL_REQUEST_EVENTS.has(eventName)) {
    const pullNumber = payload.pull_request?.number;
    return isPullNumber(pullNumber) ? [pullNumber] : [];
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

export const resolvePullRequestState = async ({
  github,
  owner,
  repo,
  pullNumber,
  workflowName = REPOSITORY_VERIFICATION_WORKFLOW,
}) => {
  const { data: pull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  const runs = await github.paginate(
    github.rest.actions.listWorkflowRunsForRepo,
    {
      owner,
      repo,
      head_sha: pull.head.sha,
      event: 'pull_request',
      per_page: 100,
    },
  );
  const workflowRun = selectAuthoritativeWorkflowRun(runs, {
    workflowName,
    headSha: pull.head.sha,
    pullNumber,
  });

  try {
    const reviewThreads = await readReviewThreadState({
      graphql: github.graphql,
      owner,
      repo,
      pullNumber,
    });
    return {
      pull,
      workflowRun,
      reviewThreads,
      reviewThreadsError: null,
    };
  } catch (error) {
    return {
      pull,
      workflowRun,
      reviewThreads: { status: 'unavailable', unresolvedCount: null },
      reviewThreadsError:
        error instanceof Error ? error.message : String(error),
    };
  }
};

export const determineVerificationStatus = (workflowRun) => {
  if (!workflowRun || workflowRun.status !== 'completed') {
    return {
      state: 'pending',
      description: 'Waiting for exact-head Repository Verification.',
    };
  }

  if (workflowRun.conclusion === 'success') {
    return {
      state: 'success',
      description: 'All Factory Floor verification lanes passed.',
    };
  }

  return {
    state: 'failure',
    description: 'Repository Verification did not pass.',
  };
};
