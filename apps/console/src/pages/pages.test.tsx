import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import {
  Overview,
  ExecutionDetail,
  ArtifactDetail,
  Topology,
  NotFound,
} from './pages.js';
import * as client from '../api/client.js';
function wrap(ui: React.ReactElement, path = '/') {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/executions/:executionId" element={ui} />
          <Route path="/artifacts/:artifactId" element={ui} />
          <Route path="/topology" element={ui} />
          <Route path="/artifacts/:artifactId" element={ui} />
          <Route path="/topology" element={ui} />
          <Route path="/nope" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
describe('console views', () => {
  it('renders stale projection overview', async () => {
    vi.spyOn(client.consoleApi, 'health').mockResolvedValue({
      status: 'ok',
      service: 'control-plane',
    });
    vi.spyOn(client.consoleApi, 'projections').mockResolvedValue({
      items: [
        {
          projection_name: 'queue-depth',
          last_sequence_number: '1',
          staleness_ms: 9999,
        },
      ],
    });
    vi.spyOn(client.consoleApi, 'events').mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    wrap(<Overview />);
    expect(await screen.findByText('queue-depth')).toBeInTheDocument();
    expect(screen.getByText(/9999ms stale/)).toBeInTheDocument();
  });
  it('preserves failed attempt history in timeline', async () => {
    vi.spyOn(client.consoleApi, 'execution').mockResolvedValue({
      causal_chain: {
        attempts: [
          {
            id: 'a1',
            attempt_number: 1,
            status: 'failed',
            failure: { message: 'verifier failed' },
          },
          { id: 'a2', attempt_number: 2, status: 'completed' },
        ],
        outputs: [],
        events: [],
        downstream_deliveries: [],
      },
    });
    wrap(<ExecutionDetail />, '/executions/ex1');
    expect(await screen.findByText(/attempt 1 failed/)).toBeInTheDocument();
    expect(screen.getByText(/replacement attempt/)).toBeInTheDocument();
  });
  it('renders artifact lineage text', async () => {
    vi.spyOn(client.consoleApi, 'artifactLineage').mockResolvedValue({
      artifact: { id: 'art' },
      derivations: [{ id: 'd1', source_artifact_id: 'a', artifact_id: 'b' }],
    });
    wrap(<ArtifactDetail />, '/artifacts/art');
    expect(await screen.findByText('Derivations')).toBeInTheDocument();
    expect(screen.getByText('d1')).toBeInTheDocument();
  });
  it('maps topology nodes and edges', async () => {
    vi.spyOn(client.consoleApi, 'topology').mockResolvedValue({
      regions: [
        {
          id: 'r',
          name: 'investigation',
          lifecycle_status: 'running',
          active_topology_revision: { revision_number: 1 },
        },
      ],
      components: [
        {
          id: 'c1',
          name: 'retrieve',
          lifecycle_status: 'running',
          definition: { name: 'retriever' },
        },
        {
          id: 'c2',
          name: 'verify',
          lifecycle_status: 'running',
          definition: { name: 'verifier' },
        },
      ],
      connections: [
        {
          id: 'edge',
          source_component_id: 'c1',
          source_port_name: 'out',
          target_component_id: 'c2',
          target_port_name: 'in',
        },
      ],
    });
    wrap(<Topology />, '/topology');
    expect(await screen.findByText(/2 components/)).toBeInTheDocument();
  });
  it('renders route not found behavior', () => {
    wrap(<NotFound />, '/nope');
    expect(screen.getByRole('alert')).toHaveTextContent('not found');
  });
});
