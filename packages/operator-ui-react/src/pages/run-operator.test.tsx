import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureDefaultOperatorClient,
  createOperatorClient,
} from '@factory-floor/operator-client-ts';
import { RunAlertsPanel, RunEventsPanel } from './run-operator.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function renderPanel(element: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false, refetchInterval: false },
          },
        })
      }
    >
      {element}
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('run-scoped operator panels', () => {
  it('renders alerts through an injected authenticated transport', async () => {
    const fetch = vi.fn(async () =>
      json({
        items: [
          {
            id: 'alert-1',
            severity: 'warning',
            kind: 'approval_required',
            title: 'Approval required',
            message: 'A durable approval is pending.',
            observedAt: '2026-07-20T00:00:00.000Z',
            source: { kind: 'approval', id: 'approval-1' },
            details: {},
          },
        ],
        nextCursor: null,
        complete: true,
        generatedAt: '2026-07-20T00:00:00.000Z',
      }),
    );
    configureDefaultOperatorClient(
      createOperatorClient({
        baseUrl: 'https://factory.example',
        token: 'short-lived-token',
        principalId: 'discord:user-1',
        adapter: 'minimal-test-shell',
        fetch: fetch as typeof globalThis.fetch,
      }),
    );

    renderPanel(<RunAlertsPanel runId="run-1" />);

    expect(await screen.findByText('Approval required')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      'https://factory.example/api/v1/operator/runs/run-1/alerts?limit=25',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer short-lived-token',
          'x-factory-floor-principal-id': 'discord:user-1',
          'x-factory-floor-adapter': 'minimal-test-shell',
        }),
      }),
    );
  });

  it('renders a caught-up finite event page and its opaque resume cursor', async () => {
    const fetch = vi.fn(async () =>
      json({
        items: [
          {
            id: 'event-1',
            eventType: 'run.completed',
            sourceKind: 'execution',
            createdAt: '2026-07-20T00:00:00.000Z',
            payload: { result: 'ok' },
          },
        ],
        nextCursor: null,
        resumeCursor: 'opaque-resume==',
        complete: true,
      }),
    );
    configureDefaultOperatorClient(
      createOperatorClient({
        principalId: 'standalone-console',
        adapter: 'standalone-console',
        fetch: fetch as typeof globalThis.fetch,
      }),
    );

    renderPanel(<RunEventsPanel runId="run-1" />);

    expect(await screen.findByText('run.completed')).toBeInTheDocument();
    expect(screen.getByText('caught-up')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy opaque-resume==' }),
    ).toBeInTheDocument();
  });
});
