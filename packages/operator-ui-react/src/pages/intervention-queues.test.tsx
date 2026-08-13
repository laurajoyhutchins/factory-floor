import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureDefaultOperatorClient,
  createOperatorClient,
  type InspectionRecord,
  type Page,
  type PageOptions,
} from '@factory-floor/operator-client-ts';
import { InterventionQueues } from './intervention-queues.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

type Loader = (
  options?: PageOptions,
  signal?: AbortSignal,
) => Promise<Page<InspectionRecord>>;

function renderQueue(loadCancellableRuns: Loader) {
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
      <InterventionQueues loadCancellableRuns={loadCancellableRuns} />
    </QueryClientProvider>,
  );
}

function cancellableRun() {
  return {
    items: [
      {
        runId: 'run-cancellable',
        commandType: 'development.task',
        regionName: 'repository-task',
      },
    ],
    nextCursor: null,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('standalone intervention queues', () => {
  it('exposes authoritative cancellable runs without requiring a known run id', async () => {
    const fetch = vi.fn(async () => json({ items: [], nextCursor: null }));
    configureDefaultOperatorClient(
      createOperatorClient({
        principalId: 'standalone-console',
        adapter: 'standalone-console',
        fetch: fetch as typeof globalThis.fetch,
      }),
    );
    const loadCancellableRuns = vi.fn(async () => cancellableRun());

    renderQueue(loadCancellableRuns);

    expect(
      await screen.findByRole('heading', { name: 'Cancellable runs' }),
    ).toBeInTheDocument();
    expect(screen.getByText('run-cancellable')).toBeInTheDocument();
    expect(screen.getByText(/development\.task/)).toBeInTheDocument();
    expect(screen.getByText(/repository-task/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeDisabled();
    expect(loadCancellableRuns).toHaveBeenCalled();
  });

  it('re-queries the canonical queue after ambiguous cancellation without resubmitting', async () => {
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') throw new TypeError('connection reset');
        return json({ items: [], nextCursor: null });
      },
    );
    configureDefaultOperatorClient(
      createOperatorClient({
        principalId: 'standalone-console',
        adapter: 'standalone-console',
        fetch: fetch as typeof globalThis.fetch,
      }),
    );
    const loadCancellableRuns = vi.fn(async () => cancellableRun());

    renderQueue(loadCancellableRuns);
    await screen.findByText('run-cancellable');
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Operator-requested stop' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));

    expect(
      await screen.findByText(/command outcome is ambiguous/i),
    ).toBeInTheDocument();
    await waitFor(() => expect(loadCancellableRuns).toHaveBeenCalledTimes(2));
    const posts = fetch.mock.calls.filter(
      ([, init]) => init?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
  });
});
