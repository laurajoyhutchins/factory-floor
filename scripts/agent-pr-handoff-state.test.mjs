import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  determineHandoffState,
  readReviewThreadState,
  selectPullNumbersForEvent,
  selectRepositoryVerificationRun,
} from './agent-pr-handoff-state.mjs';

describe('agent pull request handoff state', () => {
  it('selects every associated pull request for a completed workflow run', () => {
    expect(
      selectPullNumbersForEvent({
        eventName: 'workflow_run',
        payload: {
          workflow_run: {
            pull_requests: [{ number: 69 }, { number: 70 }, { number: 69 }],
          },
        },
      }),
    ).toEqual([69, 70]);
  });

  it('selects the target pull request for pull_request_target events', () => {
    expect(
      selectPullNumbersForEvent({
        eventName: 'pull_request_target',
        payload: { pull_request: { number: 69 } },
      }),
    ).toEqual([69]);
  });

  it('selects only the Repository Verification run for the exact head and pull request', () => {
    const runs = [
      {
        name: 'Unrelated successful workflow',
        event: 'pull_request',
        head_sha: 'head-sha',
        pull_requests: [{ number: 69 }],
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-07-19T04:04:00Z',
      },
      {
        name: 'Repository Verification',
        event: 'pull_request',
        head_sha: 'head-sha',
        pull_requests: [{ number: 70 }],
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-07-19T04:03:00Z',
      },
      {
        name: 'Repository Verification',
        event: 'pull_request',
        head_sha: 'head-sha',
        pull_requests: [{ number: 69 }],
        status: 'completed',
        conclusion: 'failure',
        created_at: '2026-07-19T04:01:00Z',
      },
      {
        name: 'Repository Verification',
        event: 'pull_request',
        head_sha: 'stale-sha',
        pull_requests: [{ number: 69 }],
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-07-19T04:05:00Z',
      },
    ];

    expect(selectRepositoryVerificationRun(runs, 'head-sha', 69)).toMatchObject(
      {
        name: 'Repository Verification',
        conclusion: 'failure',
        head_sha: 'head-sha',
        pull_requests: [{ number: 69 }],
      },
    );
  });

  it('paginates every review thread before calculating unresolved state', async () => {
    const cursors = [];
    const pages = [
      {
        nodes: [{ isResolved: false }, { isResolved: true }],
        pageInfo: { hasNextPage: true, endCursor: 'next-page' },
      },
      {
        nodes: [{ isResolved: false }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ];
    const graphql = async (_query, variables) => {
      cursors.push(variables.after);
      return {
        repository: {
          pullRequest: {
            reviewThreads: pages.shift(),
          },
        },
      };
    };

    await expect(
      readReviewThreadState({
        graphql,
        owner: 'owner',
        repo: 'repo',
        pullNumber: 69,
      }),
    ).resolves.toEqual({ status: 'available', unresolvedCount: 2 });
    expect(cursors).toEqual([null, 'next-page']);
  });

  it('blocks ready state when review-thread state is unavailable', () => {
    expect(
      determineHandoffState({
        draft: false,
        verificationRun: {
          status: 'completed',
          conclusion: 'success',
          head_sha: 'head-sha',
        },
        reviewThreads: { status: 'unavailable', unresolvedCount: null },
        mergeable: true,
        mergeableState: 'clean',
      }),
    ).toMatchObject({
      state: 'needs-attention',
      externalBlocker: 'review-state-unavailable',
    });
  });

  it.each(['dirty', 'blocked', 'behind', 'unknown', null])(
    'does not report ready when mergeable state is %s',
    (mergeableState) => {
      expect(
        determineHandoffState({
          draft: false,
          verificationRun: {
            status: 'completed',
            conclusion: 'success',
            head_sha: 'head-sha',
          },
          reviewThreads: { status: 'available', unresolvedCount: 0 },
          mergeable: true,
          mergeableState,
        }).state,
      ).not.toBe('ready');
    },
  );

  it('does not report ready when GitHub says the pull request is not mergeable', () => {
    expect(
      determineHandoffState({
        draft: false,
        verificationRun: {
          status: 'completed',
          conclusion: 'success',
          head_sha: 'head-sha',
        },
        reviewThreads: { status: 'available', unresolvedCount: 0 },
        mergeable: false,
        mergeableState: 'clean',
      }).state,
    ).not.toBe('ready');
  });

  it.each(['clean', 'unstable'])(
    'reports ready for mergeable state %s after authoritative CI and reviews pass',
    (mergeableState) => {
      expect(
        determineHandoffState({
          draft: false,
          verificationRun: {
            status: 'completed',
            conclusion: 'success',
            head_sha: 'head-sha',
          },
          reviewThreads: { status: 'available', unresolvedCount: 0 },
          mergeable: true,
          mergeableState,
        }),
      ).toMatchObject({ state: 'ready', externalBlocker: null });
    },
  );

  it('loads state logic only from the trusted default branch', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/agent-pr-handoff.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain(
      'ref: ${{ github.event.repository.default_branch }}',
    );
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('scripts/agent-pr-handoff-state.mjs');
    expect(workflow).toContain('selectPullNumbersForEvent');
    expect(workflow).not.toContain('pull_requests?.[0]');
    expect(workflow).not.toContain('github.event.pull_request.head.sha');
  });
});
