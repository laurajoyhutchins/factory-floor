import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { PortfolioClient } from '@factory-floor/operator-client-ts/portfolio';
import { Portfolio } from './portfolio.js';

function renderPortfolio(client?: PortfolioClient) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, refetchInterval: false } },
        })
      }
    >
      <MemoryRouter>
        <Portfolio client={client} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const projection = {
  entity_key: 'work:release.ci.failure-evidence',
  entity_type: 'work_item',
  executable: true,
  terminal: false,
  lifecycle: 'in_progress',
  discrepancies: [],
  blockers: [],
  portfolio: {
    semantic_key: 'release.ci.failure-evidence',
    title: 'Retain attributable CI failure evidence',
    route: 'hecate',
    priority: 'urgent',
    state: 'in_progress',
    objective: 'Make CI failure evidence durable.',
    repository: 'laurajoyhutchins/factory-floor',
  },
  owner_action: { required: false, decisions: [] },
  source_revisions: { linear: 'linear:LJH-126@revision' },
  projection_sha256: 'revision-1',
};

function client(overrides: Partial<PortfolioClient> = {}): PortfolioClient {
  return {
    status: vi.fn(async () => ({
      schema: 'portfolio-reconciler-status-v1',
      mode: 'shadow',
      observation_count: 41,
      projection_count: 12,
      projections_with_discrepancies: 0,
    })),
    entities: vi.fn(async () => ({ items: [projection] })),
    entity: vi.fn(async () => projection),
    nextWork: vi.fn(async () => ({
      schema: 'portfolio-next-work-v1',
      work: projection,
      revision: 'revision-1',
      reason: null,
      allowed_dispositions: ['completed', 'blocked'],
    })),
    ownerDecisions: vi.fn(async () => ({ items: [] })),
    search: vi.fn(async () => ({ items: [projection] })),
    ...overrides,
  };
}

describe('Portfolio page', () => {
  it('does not make requests until the host supplies a portfolio client', () => {
    renderPortfolio();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Portfolio Control Plane is not configured',
    );
  });

  it('renders next work, metrics, source revisions, and empty owner decisions', async () => {
    renderPortfolio(client());

    expect(
      await screen.findByRole('heading', { name: 'Next eligible work' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Retain attributable CI failure evidence'),
    ).toBeInTheDocument();
    expect(screen.getByText('41')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('hecate')).toBeInTheDocument();
    expect(screen.getByText(/linear:LJH-126@revision/)).toBeInTheDocument();
    const ownerSection = screen
      .getByRole('heading', { name: 'Owner decisions' })
      .closest('section');
    if (!ownerSection) throw new Error('Owner decisions section missing');
    expect(within(ownerSection).getByText('No owner decisions.')).toBeInTheDocument();
  });

  it('shows explicit no-work and disconnected states', async () => {
    const disconnected = client({
      status: vi.fn(async () => {
        throw new Error('offline');
      }),
      nextWork: vi.fn(async () => ({
        schema: 'portfolio-next-work-v1',
        work: null,
        revision: null,
        reason: 'NO_ELIGIBLE_WORK',
        allowed_dispositions: [],
      })),
    });
    renderPortfolio(disconnected);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load portfolio state',
    );
  });
});
