import { describe, expect, it } from 'vitest';

import {
  determineHandoffState,
  selectRepositoryVerificationRun,
} from './agent-pr-handoff-state.mjs';

describe('agent pull request handoff state', () => {
  it('selects only the Repository Verification run for the exact head', () => {
    const runs = [
      {
        name: 'Unrelated successful workflow',
        event: 'pull_request',
        head_sha: 'head-sha',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-07-19T04:02:00Z',
      },
      {
        name: 'Repository Verification',
        event: 'pull_request',
        head_sha: 'head-sha',
        status: 'completed',
        conclusion: 'failure',
        created_at: '2026-07-19T04:01:00Z',
      },
      {
        name: 'Repository Verification',
        event: 'pull_request',
        head_sha: 'stale-sha',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-07-19T04:03:00Z',
      },
    ];

    expect(selectRepositoryVerificationRun(runs, 'head-sha')).toMatchObject({
      name: 'Repository Verification',
      conclusion: 'failure',
      head_sha: 'head-sha',
    });
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
        mergeableState: 'clean',
      }),
    ).toMatchObject({
      state: 'needs-attention',
      externalBlocker: 'review-state-unavailable',
    });
  });

  it.each(['dirty', 'blocked', 'behind', 'unstable', 'unknown'])(
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
          mergeableState,
        }).state,
      ).not.toBe('ready');
    },
  );

  it('reports ready only for clean mergeability, successful exact-head CI, and known resolved reviews', () => {
    expect(
      determineHandoffState({
        draft: false,
        verificationRun: {
          status: 'completed',
          conclusion: 'success',
          head_sha: 'head-sha',
        },
        reviewThreads: { status: 'available', unresolvedCount: 0 },
        mergeableState: 'clean',
      }),
    ).toMatchObject({ state: 'ready', externalBlocker: null });
  });
});
