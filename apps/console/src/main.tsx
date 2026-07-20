import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router';
import { consoleApi } from './api/client.js';
import { Shell } from './components/ui.js';
import { useLiveEvents } from './hooks/liveEvents.js';
import {
  ArtifactDetail,
  Artifacts,
  ExecutionDetail,
  Executions,
  NotFound,
  Operations,
  Overview,
  Topology,
} from './pages/pages.js';
import {
  TemplateInstantiationDetail,
  TemplateInstantiations,
} from './pages/template-instantiations.js';
import './styles.css';

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
};

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
