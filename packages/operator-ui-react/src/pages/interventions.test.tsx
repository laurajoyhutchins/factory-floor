import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureDefaultOperatorClient,
  createOperatorClient,
} from '@factory-floor/operator-client-ts';
import {
  ApprovalInterventionQueue,
  RunCancellationIntervention,
} from './interventions.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function renderWithClient(element: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false, refetchInterval: false },
            mutations: { retry: false },
          },
        })
      }
    >
      {element}
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('operator intervention controls', () => {
  it('renders authoritative approval consequence context before mutation controls', async () => {
    const fetch = vi.fn(async () =>
      json({
        items: [
          {
            id: 'approval-context',
            status: 'pending',
            reason: 'Needs review',
            policyDecision: { outcome: 'require_approval' },
            artifacts: [{ id: 'artifact-1' }],
            trace: { runId: 'run-1' },
            attempts: [{ id: 'attempt-1' }],
            predictedEffects: ['publish initial state'],
            alternatives: ['reject request'],
            normalizedInputs: { templateId: 'template-1' },
          },
        ],
        nextCursor: null,
      }),
    );
    configureDefaultOperatorClient(
      createOperatorClient({
        principalId: 'standalone-console',
        adapter: 'standalone-console',
        fetch: fetch as typeof globalThis.fetch,
      }),
    );

    renderWithClient(<ApprovalInterventionQueue />);

    expect(await screen.findByText('Approval approval-context')).toBeInTheDocument();
    for (const heading of [
      'Policy decision',
      'Artifacts',
      'Trace',
      'Attempts',
      'Predicted effects',
      'Alternatives',
      'Normalized inputs',
    ])
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
  });

  it('requires reason and confirmation before approval submission and refreshes canonical state', async () => {
    let approvalReads = 0;
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST')
          return json({ id: 'approval-1', status: 'approved' });
        approvalReads += 1;
        return json({
          items:
            approvalReads === 1
              ? [
                  {
                    id: 'approval-1',
                    status: 'pending',
                    reason: 'Needs review',
                    normalizedInputs: {},
                  },
                ]
              : [],
          nextCursor: null,
        });
      },
    );
    configureDefaultOperatorClient(
      createOperatorClient({
        principalId: 'standalone-console',
        adapter: 'standalone-console',
        fetch: fetch as typeof globalThis.fetch,
      }),
    );

    renderWithClient(<ApprovalInterventionQueue />);

    const submit = await screen.findByRole('button', {
      name: 'Submit approve',
    });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Reviewed and acceptable' },
    });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(submit);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(String(post?.[0])).toContain(
      '/api/v1/operator/approvals/approval-1/decision',
    );
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      decision: 'approve',
      reason: 'Reviewed and acceptable',
    });
    expect(JSON.parse(String(post?.[1]?.body)).clientRequestId).toMatch(
      /^approval-/,
    );
  });

  it('requires explicit cancellation confirmation and uses the run-scoped command boundary', async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        void url;
        void init;
        return json({ runId: 'run-1', status: 'cancel_requested' });
      },
    );
    configureDefaultOperatorClient(
      createOperatorClient({
        principalId: 'standalone-console',
        adapter: 'standalone-console',
        fetch: fetch as typeof globalThis.fetch,
      }),
    );

    renderWithClient(<RunCancellationIntervention runId="run-1" />);

    const button = screen.getByRole('button', { name: 'Cancel run' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Operator-requested stop' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain('/api/v1/operator/runs/run-1/cancel');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      reason: 'Operator-requested stop',
    });
    expect(JSON.parse(String(init?.body)).clientRequestId).toMatch(/^cancel-/);
  });
});
