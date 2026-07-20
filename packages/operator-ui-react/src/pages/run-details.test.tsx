import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunDetailsPanel } from './run-details.js';

function renderPanel(element: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      {element}
    </QueryClientProvider>,
  );
}

describe('run details panel', () => {
  it('renders approvals, resources, policies, lineage, and projection freshness', async () => {
    const loadDetails = vi.fn(async () => ({
      runId: 'run-1',
      limits: { records: 100 },
      approvals: [
        {
          id: 'approval-1',
          status: 'requested',
          requestedAt: '2026-07-20T00:00:00.000Z',
          decidedAt: null,
          decidedBy: null,
          decisionReason: null,
          actionId: 'action-1',
          actionType: 'github.pull_request',
          risk: 'medium',
          actionStatus: 'awaiting_approval',
          policyDecisionId: 'decision-1',
          policyName: 'external-action-policy',
          policyVersion: '1',
          outcome: 'require_approval',
          policyReason: 'Human review required.',
        },
      ],
      policyDecisions: [
        {
          id: 'decision-1',
          policyName: 'external-action-policy',
          policyVersion: '1',
          evaluatorVersion: 'test/1',
          subjectKind: 'external_action',
          subjectId: 'action-1',
          inputArtifactId: null,
          normalizedInputs: {},
          outcome: 'require_approval',
          reason: 'Human review required.',
          modifications: [],
          createdAt: '2026-07-20T00:00:00.000Z',
          actionId: 'action-1',
          actionType: 'github.pull_request',
          risk: 'medium',
          actionStatus: 'awaiting_approval',
        },
      ],
      resources: [
        {
          id: 'resource-1',
          regionId: 'region-1',
          executionId: 'execution-1',
          attemptId: 'attempt-1',
          externalActionId: 'action-1',
          resourceType: 'tokens',
          quantity: '42',
          unit: 'token',
          attributes: {},
          createdAt: '2026-07-20T00:00:00.000Z',
        },
      ],
      derivations: [
        {
          id: 'derivation-1',
          artifactId: 'artifact-result',
          sourceArtifactId: 'artifact-source',
          executionId: 'execution-1',
          attemptId: 'attempt-1',
          derivationType: 'transform',
          createdAt: '2026-07-20T00:00:00.000Z',
        },
      ],
      projectionFreshness: {
        staleAfterMs: 60000,
        generatedAt: '2026-07-20T00:02:00.000Z',
        items: [
          {
            id: 'checkpoint-1',
            projectionName: 'run_status',
            streamKey: 'global',
            lastEventId: null,
            lastSequenceNumber: '12',
            updatedAt: '2026-07-20T00:00:00.000Z',
            stalenessMs: 120000,
            stale: true,
          },
        ],
      },
    }));

    renderPanel(<RunDetailsPanel runId="run-1" loadDetails={loadDetails} />);

    expect(await screen.findByText('Run governance and lineage')).toBeVisible();
    expect(screen.getByText('github.pull_request')).toBeVisible();
    expect(screen.getByText('42 token')).toBeVisible();
    expect(screen.getByText('external-action-policy@1')).toBeVisible();
    expect(screen.getByText('transform')).toBeVisible();
    expect(screen.getByText('run_status')).toBeVisible();
    expect(screen.getByText('stale')).toBeVisible();
    expect(loadDetails).toHaveBeenCalledWith('run-1');
  });
});
