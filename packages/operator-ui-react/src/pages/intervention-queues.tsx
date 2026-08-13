import { useInfiniteQuery } from '@tanstack/react-query';
import type { InspectionRecord, Page, PageOptions } from '../api/client.js';
import { LoadMore, State } from '../components/ui.js';
import {
  ApprovalInterventionQueue,
  RunCancellationIntervention,
} from './interventions.js';

export type CancellableRunsLoader = (
  options?: PageOptions,
  signal?: AbortSignal,
) => Promise<Page<InspectionRecord>>;

export function InterventionQueues({
  loadCancellableRuns,
}: {
  loadCancellableRuns: CancellableRunsLoader;
}) {
  const query = useInfiniteQuery({
    queryKey: ['operator-cancellable-runs'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      loadCancellableRuns({ cursor: pageParam, limit: 25 }, signal),
    getNextPageParam: (page: Page<InspectionRecord>) =>
      page.nextCursor ?? undefined,
  });
  const runs = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <ApprovalInterventionQueue />
      <State q={query}>
        <section>
          <h3>Cancellable runs</h3>
          {runs.length ? (
            runs.map((run) => {
              const runId = String(run.runId ?? '');
              return (
                <article className="panel" key={runId}>
                  <h4>{runId}</h4>
                  <p className="muted">
                    {String(run.commandType ?? '—')} ·{' '}
                    {String(run.regionName ?? '—')}
                  </p>
                  <RunCancellationIntervention runId={runId} />
                </article>
              );
            })
          ) : (
            <p className="muted">No cancellable runs.</p>
          )}
          <LoadMore
            hasNextPage={Boolean(query.hasNextPage)}
            isFetchingNextPage={query.isFetchingNextPage}
            fetchNextPage={query.fetchNextPage}
          />
        </section>
      </State>
    </>
  );
}
