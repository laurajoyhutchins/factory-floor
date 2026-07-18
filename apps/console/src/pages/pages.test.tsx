import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '../api/client.js';
import {
  ArtifactDetail,
  ExecutionDetail,
  Executions,
  NotFound,
  Overview,
  Topology,
  buildLineageGraph,
  buildTopologyGraph,
} from './pages.js';

function wrap(ui: React.ReactElement, path = '/', route = '*') {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, refetchInterval: false } },
        })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('console views', () => {
  it('renders projection-backed overview metrics and stale state', async () => {
    vi.spyOn(client.consoleApi, 'projections').mockResolvedValue({
      items: [
        {
          projectionName: 'queue-depth',
          lastSequenceNumber: '1',
          stalenessMs: 9_999,
          updatedAt: '2026-07-16T12:00:00Z',
          snapshot: { counts: { completed: 6 } },
        },
        {
          projectionName: 'retry-failure-counts',
          stalenessMs: 9_999,
          updatedAt: '2026-07-16T12:00:00Z',
          snapshot: {
            failedAttempts: 1,
            replacementAttempts: 1,
            deadLetteredDeliveries: 0,
          },
        },
      ],
    });
    vi.spyOn(client.consoleApi, 'events').mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    wrap(<Overview healthStatus="ok" liveState="live" />);
    expect(await screen.findByText('Delivery queue')).toBeInTheDocument();
    expect(screen.getByText('completed: 6')).toBeInTheDocument();
    expect(screen.getByText('1 failed attempts')).toBeInTheDocument();
    expect(
      screen.getByText(/maximum reported staleness 9999 ms/),
    ).toBeInTheDocument();
  });

  it('preserves failed attempt history and replacement success', async () => {
    vi.spyOn(client.consoleApi, 'execution').mockResolvedValue({
      execution: { id: 'ex1', status: 'completed' },
      causalChain: {
        attempts: [
          {
            id: 'a1',
            attemptNumber: 1,
            status: 'failed',
            failure: { message: 'verifier failed' },
          },
          { id: 'a2', attemptNumber: 2, status: 'completed' },
        ],
        inputs: [],
        outputs: [],
        events: [],
        downstreamDeliveries: [],
      },
    });
    wrap(<ExecutionDetail />, '/executions/ex1', '/executions/:executionId');
    const timelineHeading = await screen.findByRole('heading', {
      name: 'Attempt timeline',
    });
    const timeline = timelineHeading.closest('section');
    if (!timeline) throw new Error('Attempt timeline section was not rendered');
    const [failedAttempt, replacementAttempt] =
      within(timeline).getAllByRole('listitem');
    expect(within(failedAttempt).getByText('failed')).toBeInTheDocument();
    expect(
      within(replacementAttempt).getByText('Replacement attempt'),
    ).toBeInTheDocument();
    expect(
      within(replacementAttempt).getByText('completed'),
    ).toBeInTheDocument();
  });

  it('loads another opaque execution page without synthesizing a cursor', async () => {
    vi.spyOn(client.consoleApi, 'attempts').mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    const executions = vi
      .spyOn(client.consoleApi, 'executions')
      .mockImplementation(async (options) =>
        options?.cursor
          ? { items: [{ id: 'ex-2', status: 'completed' }], nextCursor: null }
          : {
              items: [{ id: 'ex-1', status: 'running' }],
              nextCursor: 'opaque-next==',
            },
      );
    const user = userEvent.setup();
    wrap(<Executions />, '/executions', '/executions');
    expect(await screen.findByLabelText('Copy ex-1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByLabelText('Copy ex-2')).toBeInTheDocument();
    expect(executions.mock.calls[1]?.[0]?.cursor).toBe('opaque-next==');
  });

  it('builds directed artifact lineage edges and text', async () => {
    const data = {
      artifact: { id: 'b' },
      derivations: [
        {
          id: 'd1',
          sourceArtifactId: 'a',
          artifactId: 'b',
          executionId: 'ex1',
        },
      ],
    };
    const graph = buildLineageGraph(data);
    expect(graph.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(graph.edges).toEqual([
      expect.objectContaining({ source: 'a', target: 'b' }),
    ]);
    vi.spyOn(client.consoleApi, 'artifactLineage').mockResolvedValue(data);
    wrap(<ArtifactDetail />, '/artifacts/b', '/artifacts/:artifactId');
    const relationshipsHeading = await screen.findByRole('heading', {
      name: 'Text relationships',
    });
    const relationships = relationshipsHeading.closest('section');
    if (!relationships)
      throw new Error('Text relationships section was not rendered');
    const relationshipList = within(relationships).getByRole('list');
    expect(
      within(relationshipList).getByLabelText('Copy a'),
    ).toBeInTheDocument();
    expect(
      within(relationshipList).getByLabelText('Copy b'),
    ).toBeInTheDocument();
  });

  it('maps active topology nodes, ports, and directed connections', async () => {
    const topology = {
      regions: [
        {
          id: 'r',
          name: 'investigation',
          lifecycleStatus: 'running',
          activeTopologyRevision: { revisionNumber: 1 },
        },
      ],
      components: [
        {
          id: 'c1',
          regionId: 'r',
          name: 'retrieve',
          lifecycleStatus: 'running',
          definition: { name: 'retriever', version: '1' },
          ports: [{ direction: 'output', name: 'evidence' }],
        },
        {
          id: 'c2',
          regionId: 'r',
          name: 'verify',
          lifecycleStatus: 'running',
          definition: { name: 'verifier', version: '1' },
          ports: [{ direction: 'input', name: 'evidence' }],
        },
      ],
      connections: [
        {
          id: 'edge',
          sourceComponentId: 'c1',
          sourcePortName: 'evidence',
          targetComponentId: 'c2',
          targetPortName: 'evidence',
        },
      ],
    };
    const graph = buildTopologyGraph(topology);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges[0]).toMatchObject({ source: 'c1', target: 'c2' });
    vi.spyOn(client.consoleApi, 'topology').mockResolvedValue(topology);
    wrap(<Topology />, '/topology', '/topology');
    expect(await screen.findByText(/2 components/)).toBeInTheDocument();
    expect(screen.getAllByText(/evidence/).length).toBeGreaterThan(0);
  });

  it('renders route not found behavior', () => {
    wrap(<NotFound />, '/nope');
    expect(screen.getByRole('alert')).toHaveTextContent('not found');
  });
});
