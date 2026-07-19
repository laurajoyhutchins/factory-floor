import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  determineReviewClearanceStatus,
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
  it('selects pull requests for every supported event without duplication', () => {
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
        eventName: 'pull_request_target',
        payload: { pull_request: { number: 82 } },
      }),
    ).toEqual([82]);

    expect(
      selectPullNumbersForClearanceEvent({
        eventName: 'issue_comment',
        payload: { issue: { number: 82, pull_request: {} } },
      }),
    ).toEqual([82]);

    expect(
      selectPullNumbersForClearanceEvent({
        eventName: 'issue_comment',
        payload: { issue: { number: 82 } },
      }),
    ).toEqual([]);
  });

  it('selects only the authoritative exact-head workflow run for the pull request', () => {
    const runs = [
      {
        id: 1,
        name: 'Repository Verification',
        event: 'pull_request',
        head_sha: HEAD_SHA,
        pull_requests: [{ number: 82 }],
        status: 'completed',
        conclusion: 'failure',
        created_at: '2026-07-19T20:00:00Z',
      },
      {
        id: 2,
        name: 'Repository Verification',
        event: 'pull_request',
        head_sha: HEAD_SHA,
        pull_requests: [{ number: 83 }],
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-07-19T20:02:00Z',
      },
      {
        id: 3,
        name: 'Unrelated workflow',
        event: 'pull_request',
        head_sha: HEAD_SHA,
        pull_requests: [{ number: 82 }],
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-07-19T20:03:00Z',
      },
      {
        id: 4,
        name: 'Repository Verification',
        event: 'pull_request',
        head_sha: OLD_SHA,
        pull_requests: [{ number: 82 }],
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-07-19T20:04:00Z',
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

  it('accepts only an owner-authored exact-head clearance', () => {
    expect(
      parseReviewClearance({
        comments: [
          {
            id: 1,
            user: { login: 'someone-else' },
            body: clearanceBody(),
            created_at: '2026-07-19T20:00:00Z',
            updated_at: '2026-07-19T20:00:00Z',
          },
          {
            id: 2,
            user: { login: 'laurajoyhutchins' },
            body: clearanceBody(),
            created_at: '2026-07-19T20:01:00Z',
            updated_at: '2026-07-19T20:01:00Z',
          },
        ],
        ownerLogin: 'laurajoyhutchins',
        headSha: HEAD_SHA,
      }),
    ).toMatchObject({ state: 'cleared', reviewedHead: HEAD_SHA, commentId: 2 });
  });

  it('treats a clearance for an older head as stale', () => {
    expect(
      parseReviewClearance({
        comments: [
          {
            id: 1,
            user: { login: 'laurajoyhutchins' },
            body: clearanceBody({ sha: OLD_SHA }),
            created_at: '2026-07-19T20:00:00Z',
            updated_at: '2026-07-19T20:00:00Z',
          },
        ],
        ownerLogin: 'laurajoyhutchins',
        headSha: HEAD_SHA,
      }),
    ).toMatchObject({ state: 'stale', reviewedHead: OLD_SHA });
  });

  it('lets the latest owner decision supersede an earlier clearance', () => {
    expect(
      parseReviewClearance({
        comments: [
          {
            id: 1,
            user: { login: 'laurajoyhutchins' },
            body: clearanceBody(),
            created_at: '2026-07-19T20:00:00Z',
            updated_at: '2026-07-19T20:00:00Z',
          },
          {
            id: 2,
            user: { login: 'laurajoyhutchins' },
            body: clearanceBody({ disposition: 'Not cleared for merge.' }),
            created_at: '2026-07-19T20:01:00Z',
            updated_at: '2026-07-19T20:01:00Z',
          },
        ],
        ownerLogin: 'laurajoyhutchins',
        headSha: HEAD_SHA,
      }),
    ).toMatchObject({ state: 'not-cleared', commentId: 2 });
  });

  it('reports success only when exact-head CI, conversations, and clearance all pass', () => {
    expect(
      determineReviewClearanceStatus({
        draft: false,
        workflowRun: { status: 'completed', conclusion: 'success' },
        reviewThreads: { status: 'available', unresolvedCount: 0 },
        clearance: { state: 'cleared' },
      }),
    ).toMatchObject({ state: 'success' });
  });

  it.each([
    [
      'draft',
      { draft: true, workflowRun: null, reviewThreads: null, clearance: null },
    ],
    [
      'awaiting CI',
      {
        draft: false,
        workflowRun: { status: 'in_progress', conclusion: null },
        reviewThreads: { status: 'available', unresolvedCount: 0 },
        clearance: { state: 'cleared' },
      },
    ],
    [
      'missing clearance',
      {
        draft: false,
        workflowRun: { status: 'completed', conclusion: 'success' },
        reviewThreads: { status: 'available', unresolvedCount: 0 },
        clearance: { state: 'missing' },
      },
    ],
    [
      'stale clearance',
      {
        draft: false,
        workflowRun: { status: 'completed', conclusion: 'success' },
        reviewThreads: { status: 'available', unresolvedCount: 0 },
        clearance: { state: 'stale' },
      },
    ],
  ])('keeps the required status pending for %s', (_label, input) => {
    expect(determineReviewClearanceStatus(input).state).toBe('pending');
  });

  it('fails closed for failed CI, unresolved threads, or unavailable review state', () => {
    expect(
      determineReviewClearanceStatus({
        draft: false,
        workflowRun: { status: 'completed', conclusion: 'failure' },
        reviewThreads: { status: 'available', unresolvedCount: 0 },
        clearance: { state: 'cleared' },
      }).state,
    ).toBe('failure');

    expect(
      determineReviewClearanceStatus({
        draft: false,
        workflowRun: { status: 'completed', conclusion: 'success' },
        reviewThreads: { status: 'available', unresolvedCount: 1 },
        clearance: { state: 'cleared' },
      }).state,
    ).toBe('failure');

    expect(
      determineReviewClearanceStatus({
        draft: false,
        workflowRun: { status: 'completed', conclusion: 'success' },
        reviewThreads: { status: 'unavailable', unresolvedCount: null },
        clearance: { state: 'cleared' },
      }).state,
    ).toBe('error');
  });

  it('wires the trusted workflow and stable aggregate checks', () => {
    const clearanceWorkflow = readFileSync(
      new URL('../.github/workflows/review-clearance.yml', import.meta.url),
      'utf8',
    );
    const verificationWorkflow = readFileSync(
      new URL('../.github/workflows/verification-gate.yml', import.meta.url),
      'utf8',
    );

    expect(clearanceWorkflow).toContain('statuses: write');
    expect(clearanceWorkflow).toContain("context: 'review / cleared'");
    expect(clearanceWorkflow).toContain(
      'ref: ${{ github.event.repository.default_branch }}',
    );
    expect(clearanceWorkflow).toContain('persist-credentials: false');
    expect(clearanceWorkflow).toContain('scripts/review-clearance-state.mjs');
    expect(clearanceWorkflow).toContain('issue_comment:');
    expect(clearanceWorkflow).not.toContain(
      'github.event.pull_request.head.sha',
    );

    expect(verificationWorkflow).toContain("context: 'verify'");
    expect(verificationWorkflow).toContain('Repository Verification');
    expect(verificationWorkflow).toContain('selectAuthoritativeWorkflowRun');
    expect(verificationWorkflow).toContain('persist-credentials: false');
  });
});
