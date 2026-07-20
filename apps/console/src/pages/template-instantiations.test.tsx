import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '../api/client.js';
import {
  TemplateInstantiationDetail,
  TemplateInstantiations,
} from './template-instantiations.js';

function wrap(ui: React.ReactElement, path: string, route: string) {
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

afterEach(() => vi.restoreAllMocks());

describe('template-instantiation console views', () => {
  it('lists deterministic region-scoped history and supports accessible scope changes', async () => {
    vi.spyOn(client.consoleApi, 'regions').mockResolvedValue({
      items: [
        { id: 'region-a', name: 'Assembly' },
        { id: 'region-b', name: 'Verification' },
      ],
      nextCursor: null,
    });
    const instantiations = vi
      .spyOn(client.consoleApi, 'templateInstantiations')
      .mockImplementation(async (scope) => ({
        items:
          scope.regionId === 'region-b'
            ? [
                {
                  id: 'inst-b',
                  requestId: 'request-b',
                  disposition: 'existing',
                  targetRegion: { id: 'region-b', name: 'Verification' },
                  topologyRevision: { id: 'revision-b', revisionNumber: 2 },
                  template: { id: 'template-b', name: 'seeded', version: '1' },
                  createdAt: '2026-07-20T00:00:00.000Z',
                },
              ]
            : [],
        nextCursor: null,
      }));

    const user = userEvent.setup();
    wrap(<TemplateInstantiations />, '/instantiations', '/instantiations');

    const selector = await screen.findByRole('combobox', { name: 'Region' });
    expect(
      screen.getByText('No template instantiations recorded for this region.'),
    ).toBeInTheDocument();
    await user.selectOptions(selector, 'region-b');

    expect(await screen.findByRole('link', { name: 'inst-b' })).toHaveAttribute(
      'href',
      '/instantiations/inst-b',
    );
    expect(screen.getByText('seeded@1')).toBeInTheDocument();
    expect(screen.getByText('existing')).toBeInTheDocument();
    expect(instantiations).toHaveBeenLastCalledWith(
      { regionId: 'region-b' },
      { cursor: null, limit: 25 },
      expect.any(AbortSignal),
    );
  });

  it('renders complete textual seed provenance without requiring a graph', async () => {
    vi.spyOn(client.consoleApi, 'templateInstantiation').mockResolvedValue({
      id: 'inst-a',
      requestId: 'request-a',
      requestDigest: 'a'.repeat(64),
      effectiveDigest: 'b'.repeat(64),
      disposition: 'created',
      targetRegion: { id: 'region-a', name: 'Assembly' },
      topologyRevision: {
        id: 'revision-a',
        revisionNumber: 1,
        digest: 'c'.repeat(64),
      },
      template: {
        id: 'template-a',
        name: 'seeded',
        version: '1',
        digest: 'd'.repeat(64),
      },
      parameters: { completedSteps: ['fetch'] },
      componentConfiguration: {},
      source: { kind: 'internal', operation: 'test' },
      referencedDefinitions: [],
      initialStates: [
        {
          stateVersionId: 'state-version-a',
          versionNumber: 1,
          owner: {
            componentInstanceId: 'component-a',
            componentName: 'verifier',
            portName: 'checkpoint',
          },
          schema: {
            id: 'schema-a',
            name: 'checkpoint',
            version: '1',
            digest: 'e'.repeat(64),
          },
          artifact: {
            id: 'artifact-a',
            digestAlgorithm: 'sha256',
            digest: 'f'.repeat(64),
            sizeBytes: '28',
            mediaType: 'application/json',
            state: 'committed',
          },
          value: { completedSteps: ['fetch'] },
          source: {
            kind: 'templateInstantiation',
            instantiationId: 'inst-a',
            templateId: 'template-a',
            regionId: 'region-a',
          },
          provenance: { kind: 'templateInstantiation' },
          createdAt: '2026-07-20T00:00:00.000Z',
        },
      ],
      createdAt: '2026-07-20T00:00:00.000Z',
    });

    wrap(
      <TemplateInstantiationDetail />,
      '/instantiations/inst-a',
      '/instantiations/:instantiationId',
    );

    expect(
      await screen.findByRole('heading', { name: 'Template instantiation' }),
    ).toBeInTheDocument();
    expect(screen.getByText('verifier.checkpoint')).toBeInTheDocument();
    expect(screen.getByText('checkpoint@1')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy artifact-a')).toBeInTheDocument();
    expect(screen.getByText(/completedSteps/)).toBeInTheDocument();
    expect(screen.getByText(/templateInstantiation/)).toBeInTheDocument();
  });
});
