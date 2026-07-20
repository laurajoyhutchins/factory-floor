import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { consoleApi } from '@factory-floor/operator-client-ts';
import {
  ArtifactDetail,
  Artifacts,
  ExecutionDetail,
  Executions,
  NotFound,
  Operations,
  Overview,
  PendingApprovals,
  RunOperatorWorkspace,
  Shell,
  TemplateInstantiationDetail,
  TemplateInstantiations,
  Topology,
  useLiveEvents,
} from '@factory-floor/operator-ui-react';
import '@factory-floor/operator-ui-react/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Route,
  Routes,
  useLocation,
  useParams,
} from 'react-router';
import './api/client.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 15_000,
      staleTime: 5_000,
      retry: 1,
    },
  },
});

const titles: Record<string, string> = {
  topology: 'Topology',
  executions: 'Executions',
  artifacts: 'Artifacts',
  instantiations: 'Template instantiations',
  operations: 'Operations',
  approvals: 'Pending approvals',
  runs: 'Run inspection',
};

function RunRoute() {
  const { runId = '' } = useParams();
  return <RunOperatorWorkspace runId={runId} />;
}

function App() {
  const live = useLiveEvents(50);
  const location = useLocation();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => consoleApi.health(signal),
  });
  const segment = location.pathname.split('/').filter(Boolean)[0];
  const title = segment ? (titles[segment] ?? 'Not found') : 'Overview';
  const healthStatus =
    health.data?.status ?? (health.isError ? 'disconnected' : 'checking');

  return (
    <Shell
      title={title}
      live={live.state}
      controlPlane={healthStatus}
      lastRefreshed={health.dataUpdatedAt || undefined}
    >
      <Routes>
        <Route
          path="/"
          element={
            <Overview
              healthStatus={healthStatus}
              liveEvents={live.events}
              liveState={live.state}
            />
          }
        />
        <Route path="/topology" element={<Topology />} />
        <Route path="/executions" element={<Executions />} />
        <Route path="/executions/:executionId" element={<ExecutionDetail />} />
        <Route path="/artifacts" element={<Artifacts />} />
        <Route path="/artifacts/:artifactId" element={<ArtifactDetail />} />
        <Route path="/instantiations" element={<TemplateInstantiations />} />
        <Route
          path="/instantiations/:instantiationId"
          element={<TemplateInstantiationDetail />}
        />
        <Route path="/operations" element={<Operations />} />
        <Route path="/approvals" element={<PendingApprovals />} />
        <Route path="/runs/:runId" element={<RunRoute />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Shell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
