import { createOperatorClient } from '@factory-floor/operator-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { Overview } from './pages/pages.js';
import { OperatorClientProvider } from './provider.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('minimal operator UI shell', () => {
  it('renders reusable views with injected authentication and transport', async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        const url = String(input);
        if (url.includes('/projections')) {
          return json({
            items: [
              {
                projection_name: 'queue-depth',
                updated_at: '2026-07-20T00:00:00Z',
                staleness_ms: 0,
                snapshot: { counts: { completed: 2 } },
              },
            ],
          });
        }
        return json({ items: [], nextCursor: null });
      },
    );
    const client = createOperatorClient({
      fetch,
      headers: {
        authorization: 'Bearer injected-session',
        'x-factory-floor-principal-id': 'operator:test',
        'x-factory-floor-adapter': 'minimal-test-shell',
      },
    });

    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, refetchInterval: false } },
          })
        }
      >
        <MemoryRouter>
          <OperatorClientProvider client={client}>
            <Overview healthStatus="healthy" liveState="live" />
          </OperatorClientProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('completed: 2')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalled();
    const request = fetch.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({
      authorization: 'Bearer injected-session',
      'x-factory-floor-principal-id': 'operator:test',
      'x-factory-floor-adapter': 'minimal-test-shell',
    });
  });
});
