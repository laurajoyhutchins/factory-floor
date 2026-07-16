import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router';
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
import './styles.css';
const qc = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 15000, staleTime: 5000 } },
});
function App() {
  const live = useLiveEvents(50);
  const loc = useLocation();
  const title =
    loc.pathname === '/'
      ? 'Overview'
      : loc.pathname.split('/')[1] || 'Overview';
  return (
    <Shell title={title} live={live.state}>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/topology" element={<Topology />} />
        <Route path="/executions" element={<Executions />} />
        <Route path="/executions/:executionId" element={<ExecutionDetail />} />
        <Route path="/artifacts" element={<Artifacts />} />
        <Route path="/artifacts/:artifactId" element={<ArtifactDetail />} />
        <Route path="/operations" element={<Operations />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Shell>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
