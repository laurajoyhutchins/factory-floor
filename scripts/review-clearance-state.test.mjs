import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  determineReviewClearanceStatus,
  determineVerificationStatus,
  parseReviewClearance,
  selectAuthoritativeWorkflowRun,
  selectPullNumbersForClearanceEvent,
} from './review-clearance-state.mjs';

const HEAD_SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);

const clearanceBody = ({
  sha = HEAD_SHA,
  disposition = 'Cleared for merge.',
} = {}) => `<!-- review-clearance:v1 -->

## Final review

Reviewed head: \`${sha}\`

Scope reviewed:
- complete diff

Findings and changes:
- none

Verification:
- repository verification passed

Remaining limitations:
- none

Disposition: ${disposition}`;

describe('review clearance state', () => {
  it('reuses shared event and exact-head workflow selection', () => {
    expect(
      selectPullNumbersForClearanceEvent({
        eventName: 'workflow_run',
        payload: {
          workflow_run: {
            pull_requests: [{ number: 81 }, { number: 82 }, { number: 81 }],
          },
        },
      }),
    ).toEqual([81, 82]);
    expect(
      selectPullNumbersForClearanceEvent({
        eventName: 'issue_comment',
        payload: { issue: { number: 82, pull_request: {} } },
      }),
    ).toEqual([82]);

    const runs = [
      {
        id: 1,
        name: 'Repository Verification',
        event: 'pull_request',
        head_sha: HEAD_SHA,
        pull_requests: [{ number: 82 }],
        conclusion: 'failure',
        created_at: '2026-07-19T20:00:00Z',
      },
      {
        id: 2,
        name: 'Repository Verification',
        event: 'pull_request',
        head_sha: OLD_SHA,
        pull_requests: [{ number: 82 }],
        conclusion: 'success',
        created_at: '2026-07-19T20:01:00Z',
      },
    ];
    expect(
      selectAuthoritativeWorkflowRun(runs, {
        workflowName: 'Repository Verification',
        headSha: HEAD_SHA,
        pullNumber: 82,
      }),
    ).toMatchObject({ id: 1, conclusion: 'failure' });
  });

  it('accepts only the latest owner-authored exact-head clearance', () => {
    expect(
      parseReviewClearance({
        comments: [
          {
            id: 1,
            user: { login: 'someone-else' },
            body: clearanceBody(),
            created_at: '2026-07-19T20:00:00Z',
          },
          {
            id: 2,
            user: { login: 'laurajoyhutchins' },
            body: clearanceBody(),
            created_at: '2026-07-19T20:01:00Z',
          },
        ],
        ownerLogin: 'laurajoyhutchins',
        headSha: HEAD_SHA,
      }),
    ).toMatchObject({ state: 'cleared', reviewedHead: HEAD_SHA, commentId: 2 });

    expect(
      parseReviewClearance({
        comments: [
          {
            id: 3,
            user: { login: 'laurajoyhutchins' },
            body: clearanceBody({ sha: OLD_SHA }),
            created_at: '2026-07-19T20:02:00Z',
          },
        ],
        ownerLogin: 'laurajoyhutchins',
        headSha: HEAD_SHA,
      }),
    ).toMatchObject({ state: 'stale', reviewedHead: OLD_SHA });
  });

  it('lets a later owner decision revoke an earlier clearance', () => {
    expect(
      parseReviewClearance({
        comments: [
          {
            id: 1,
            user: { login: 'laurajoyhutchins' },
            body: clearanceBody(),
            created_at: '2026-07-19T20:00:00Z',
          },
          {
            id: 2,
            user: { login: 'laurajoyhutchins' },
            body: clearanceBody({ disposition: 'Not cleared for merge.' }),
            created_at: '2026-07-19T20:01:00Z',
          },
        ],
        ownerLogin: 'laurajoyhutchins',
        headSha: HEAD_SHA,
      }),
    ).toMatchObject({ state: 'not-cleared', commentId: 2 });
  });

  it('fails closed unless exact-head CI, review threads, and clearance pass', () => {
    expect(
      determineReviewClearanceStatus({
        draft: false,
        workflowRun: { status: 'completed', conclusion: 'success' },
        reviewThreads: { status: 'available', unresolvedCount: 0 },
        clearance: { state: 'cleared' },
      }),
    ).toMatchObject({ state: 'success' });
    expect(
      determineReviewClearanceStatus({
        draft: false,
        workflowRun: { status: 'completed', conclusion: 'success' },
        reviewThreads: { status: 'available', unresolvedCount: 1 },
        clearance: { state: 'cleared' },
      }),
    ).toMatchObject({ state: 'failure' });
    expect(
      determineReviewClearanceStatus({
        draft: false,
        workflowRun: { status: 'completed', conclusion: 'success' },
        reviewThreads: { status: 'unavailable', unresolvedCount: null },
        clearance: { state: 'cleared' },
      }),
    ).toMatchObject({ state: 'error' });
  });

  it('preserves stable verify status semantics', () => {
    expect(determineVerificationStatus(null).state).toBe('pending');
    expect(
      determineVerificationStatus({ status: 'completed', conclusion: 'success' })
        .state,
    ).toBe('success');
    expect(
      determineVerificationStatus({ status: 'completed', conclusion: 'failure' })
        .state,
    ).toBe('failure');
  });

  it('publishes both stable statuses from trusted default-branch logic', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/review-clearance.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain('statuses: write');
    expect(workflow).toContain("context: 'verify'");
    expect(workflow).toContain("context: 'review / cleared'");
    expect(workflow).toContain('scripts/github-pr-state.mjs');
    expect(workflow).toContain('scripts/review-clearance-state.mjs');
    expect(workflow).toContain(
      'ref: ${{ github.event.repository.default_branch }}',
    );
    expect(workflow).toContain('persist-credentials: false');
    expect(
      existsSync(
        new URL('../.github/workflows/verification-gate.yml', import.meta.url),
      ),
    ).toBe(false);
  });
});
