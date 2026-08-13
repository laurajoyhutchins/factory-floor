import {
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
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
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: ['operator-cancellable-runs'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      loadCancellableRuns({ cursor: pageParam, limit: 25 }, signal),
    getNextPageParam: (page: Page<InspectionRecord>) =>
      page.nextCursor ?? undefined,
  });
  const refetch = query.refetch;
  useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (
          event.type === 'updated' &&
          (event.mutation.state.status === 'success' ||
            event.mutation.state.status === 'error')
        )
          void refetch();
      }),
    [queryClient, refetch],
  );
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
