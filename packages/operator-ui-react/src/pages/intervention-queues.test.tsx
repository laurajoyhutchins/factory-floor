import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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
    const loadCancellableRuns = vi.fn(async () => ({
      items: [
        {
          runId: 'run-cancellable',
          commandType: 'development.task',
          regionName: 'repository-task',
        },
      ],
      nextCursor: null,
    }));

    renderQueue(loadCancellableRuns);

    expect(
      await screen.findByRole('heading', { name: 'Cancellable runs' }),
    ).toBeInTheDocument();
    expect(screen.getByText('run-cancellable')).toBeInTheDocument();
    expect(screen.getByText('development.task')).toBeInTheDocument();
    expect(screen.getByText('repository-task')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeDisabled();
    expect(loadCancellableRuns).toHaveBeenCalled();
  });
});
