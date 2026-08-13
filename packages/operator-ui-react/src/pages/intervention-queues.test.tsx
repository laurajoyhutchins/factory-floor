import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureDefaultOperatorClient,
  createOperatorClient,
} from '@factory-floor/operator-client-ts';
import { InterventionQueues } from './intervention-queues.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function renderQueue() {
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
      <InterventionQueues />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('standalone intervention queues', () => {
  it('exposes authoritative cancellable runs without requiring a known run id', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/api/v1/operator/cancellable-runs'))
        return json({
          items: [
            {
              runId: 'run-cancellable',
              commandType: 'development.task',
              regionId: 'region-1',
              regionName: 'repository-task',
              createdAt: '2026-08-13T00:00:00.000Z',
            },
          ],
          nextCursor: null,
        });
      if (path.includes('/api/v1/operator/approvals'))
        return json({ items: [], nextCursor: null });
      throw new Error(`Unexpected request: ${path}`);
    });
    configureDefaultOperatorClient(
      createOperatorClient({
        principalId: 'standalone-console',
        adapter: 'standalone-console',
        fetch: fetch as typeof globalThis.fetch,
      }),
    );

    renderQueue();

    expect(
      await screen.findByRole('heading', { name: 'Cancellable runs' }),
    ).toBeInTheDocument();
    expect(screen.getByText('run-cancellable')).toBeInTheDocument();
    expect(screen.getByText('development.task')).toBeInTheDocument();
    expect(screen.getByText('repository-task')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeDisabled();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/operator/cancellable-runs'),
      expect.anything(),
    );
  });
});
