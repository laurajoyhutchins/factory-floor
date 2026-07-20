import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  REPOSITORY_VERIFICATION_WORKFLOW,
  determineVerificationStatus,
  resolvePullRequestState,
  selectAuthoritativeWorkflowRun,
  selectPullNumbersForEvent,
} from './github-pr-state.mjs';

const HEAD_SHA = 'a'.repeat(40);

describe('shared GitHub pull request state', () => {
  it('resolves associated pull requests for every trusted event shape', () => {
    expect(
      selectPullNumbersForEvent({
        eventName: 'workflow_run',
        payload: {
          workflow_run: {
            pull_requests: [{ number: 4 }, { number: 5 }, { number: 4 }],
          },
        },
      }),
    ).toEqual([4, 5]);
    expect(
      selectPullNumbersForEvent({
        eventName: 'pull_request_review',
        payload: { pull_request: { number: 6 } },
      }),
    ).toEqual([6]);
    expect(
      selectPullNumbersForEvent({
        eventName: 'issue_comment',
        payload: { issue: { number: 7, pull_request: {} } },
      }),
    ).toEqual([7]);
    expect(
      selectPullNumbersForEvent({
        eventName: 'issue_comment',
        payload: { issue: { number: 8 } },
      }),
    ).toEqual([]);
  });

  it('selects the newest exact-head run for the requested pull request', () => {
    expect(
      selectAuthoritativeWorkflowRun(
        [
          {
            id: 1,
            name: REPOSITORY_VERIFICATION_WORKFLOW,
            event: 'pull_request',
            head_sha: HEAD_SHA,
            pull_requests: [{ number: 9 }],
            created_at: '2026-07-20T12:00:00Z',
          },
          {
            id: 2,
            name: REPOSITORY_VERIFICATION_WORKFLOW,
            event: 'pull_request',
            head_sha: HEAD_SHA,
            pull_requests: [{ number: 9 }],
            created_at: '2026-07-20T12:01:00Z',
          },
        ],
        {
          workflowName: REPOSITORY_VERIFICATION_WORKFLOW,
          headSha: HEAD_SHA,
          pullNumber: 9,
        },
      ),
    ).toMatchObject({ id: 2 });
  });

  it('loads the pull, exact-head run, and every review-thread page once', async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        number: 9,
        draft: false,
        head: { sha: HEAD_SHA },
      },
    });
    const paginate = vi.fn().mockResolvedValue([
      {
        id: 3,
        name: REPOSITORY_VERIFICATION_WORKFLOW,
        event: 'pull_request',
        head_sha: HEAD_SHA,
        pull_requests: [{ number: 9 }],
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-07-20T12:02:00Z',
      },
    ]);
    const pages = [
      {
        nodes: [{ isResolved: false }],
        pageInfo: { hasNextPage: true, endCursor: 'next' },
      },
      {
        nodes: [{ isResolved: true }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ];
    const graphql = vi.fn().mockImplementation(async () => ({
      repository: {
        pullRequest: { reviewThreads: pages.shift() },
      },
    }));
    const github = {
      rest: {
        pulls: { get: pullsGet },
        actions: { listWorkflowRunsForRepo: vi.fn() },
      },
      paginate,
      graphql,
    };

    await expect(
      resolvePullRequestState({
        github,
        owner: 'owner',
        repo: 'repo',
        pullNumber: 9,
      }),
    ).resolves.toMatchObject({
      pull: { number: 9 },
      workflowRun: { id: 3 },
      reviewThreads: { status: 'available', unresolvedCount: 1 },
      reviewThreadsError: null,
    });
    expect(pullsGet).toHaveBeenCalledOnce();
    expect(paginate).toHaveBeenCalledOnce();
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('fails review state closed while preserving pull and workflow state', async () => {
    const github = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: { number: 9, head: { sha: HEAD_SHA } },
          }),
        },
        actions: { listWorkflowRunsForRepo: vi.fn() },
      },
      paginate: vi.fn().mockResolvedValue([]),
      graphql: vi.fn().mockRejectedValue(new Error('denied')),
    };

    await expect(
      resolvePullRequestState({
        github,
        owner: 'owner',
        repo: 'repo',
        pullNumber: 9,
      }),
    ).resolves.toMatchObject({
      workflowRun: null,
      reviewThreads: { status: 'unavailable', unresolvedCount: null },
      reviewThreadsError: 'denied',
    });
  });

  it('maps authoritative workflow state to the stable verify status', () => {
    expect(determineVerificationStatus(null)).toMatchObject({ state: 'pending' });
    expect(
      determineVerificationStatus({ status: 'completed', conclusion: 'success' }),
    ).toMatchObject({ state: 'success' });
    expect(
      determineVerificationStatus({ status: 'completed', conclusion: 'failure' }),
    ).toMatchObject({ state: 'failure' });
  });

  it('uses one trusted status publisher while keeping agent handoff isolated', () => {
    const clearanceWorkflow = readFileSync(
      new URL('../.github/workflows/review-clearance.yml', import.meta.url),
      'utf8',
    );
    const agentWorkflow = readFileSync(
      new URL('../.github/workflows/agent-pr-handoff.yml', import.meta.url),
      'utf8',
    );

    expect(existsSync(new URL('../.github/workflows/verification-gate.yml', import.meta.url))).toBe(false);
    expect(clearanceWorkflow).toContain("context: 'verify'");
    expect(clearanceWorkflow).toContain("context: 'review / cleared'");
    expect(clearanceWorkflow).toContain('scripts/github-pr-state.mjs');
    expect(agentWorkflow).toContain('pull-requests: write');
    expect(agentWorkflow).toContain('scripts/github-pr-state.mjs');
    expect(agentWorkflow).toContain(
      'ref: ${{ github.event.repository.default_branch }}',
    );
  });
});
