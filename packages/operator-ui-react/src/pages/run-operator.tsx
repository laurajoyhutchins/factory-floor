import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  operatorClient,
  type InspectionRecord,
  type Page,
  type RunEventPage,
} from '../api/client.js';
import {
  CopyId,
  DataTable,
  JsonBlock,
  LoadMore,
  State,
  StatusBadge,
  Timestamp,
} from '../components/ui.js';

const record = (value: unknown): InspectionRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as InspectionRecord)
    : {};

const records = (value: unknown): InspectionRecord[] =>
  Array.isArray(value) ? value.map(record) : [];

function pageItems<T extends InspectionRecord>(query: {
  data?: { pages: Array<Page<T>> };
}): T[] {
  return query.data?.pages.flatMap((page) => page.items) ?? [];
}

export function RunStatusPanel({ runId }: { runId: string }) {
  const query = useQuery({
    queryKey: ['operator-run', runId],
    enabled: runId.length > 0,
    queryFn: ({ signal }) => operatorClient.run(runId, signal),
  });
  const run = query.data ?? {};

  return (
    <State q={query}>
      <section>
        <div className="section-heading">
          <div>
            <h3>Run status</h3>
            <p>
              <CopyId value={run.runId ?? runId} />{' '}
              <StatusBadge value={run.status} />
            </p>
          </div>
          <Timestamp value={run.completedAt ?? run.createdAt} />
        </div>
        <DataTable
          rows={[run]}
          cols={[
            'commandType',
            'regionName',
            'status',
            'retryCount',
            'pendingApprovalCount',
            'createdAt',
            'completedAt',
          ]}
        />
        <h4>Counts</h4>
        <JsonBlock value={run.counts} />
        {run.blockingReason ? (
          <>
            <h4>Blocking reason</h4>
            <JsonBlock value={run.blockingReason} />
          </>
        ) : null}
      </section>
    </State>
  );
}

export function RunTracePanel({ runId }: { runId: string }) {
  const query = useQuery({
    queryKey: ['operator-run-trace', runId],
    enabled: runId.length > 0,
    queryFn: ({ signal }) => operatorClient.runTrace(runId, signal),
  });
  const trace = query.data ?? {};

  return (
    <State q={query}>
      <section>
        <h3>Bounded durable trace</h3>
        {[
          ['Deliveries', trace.deliveries],
          ['Executions', trace.executions],
          ['Attempts', trace.attempts],
          ['Outputs', trace.outputs],
          ['Events', trace.events],
        ].map(([title, value]) => {
          const page = record(value);
          return (
            <article key={String(title)} className="panel">
              <div className="section-heading">
                <h4>{String(title)}</h4>
                {page.truncated ? <StatusBadge value="truncated" /> : null}
              </div>
              <JsonBlock value={page.items ?? []} />
            </article>
          );
        })}
      </section>
    </State>
  );
}

export function RunTopologyPanel({ runId }: { runId: string }) {
  const query = useQuery({
    queryKey: ['operator-run-topology', runId],
    enabled: runId.length > 0,
    queryFn: ({ signal }) => operatorClient.runTopology(runId, {}, signal),
  });
  const topology = query.data ?? {};

  return (
    <State q={query}>
      <section>
        <div className="section-heading">
          <div>
            <h3>Run topology</h3>
            <p className="muted">
              Immutable execution context with run-filtered runtime records.
            </p>
          </div>
          <JsonBlock value={topology.bounds} />
        </div>
        <h4>Regions</h4>
        <DataTable
          rows={records(topology.regions)}
          cols={['id', 'name', 'lifecycleStatus', 'lifecycleEpoch']}
        />
        <h4>Topology revisions</h4>
        <DataTable
          rows={records(topology.topologyRevisions)}
          cols={[
            'id',
            'regionId',
            'revisionNumber',
            'contentDigest',
            'activatedAt',
          ]}
        />
        <h4>Components</h4>
        <DataTable
          rows={records(topology.components)}
          cols={[
            'id',
            'regionId',
            'topologyRevisionId',
            'name',
            'lifecycleStatus',
            'definition',
            'ports',
          ]}
        />
        <h4>Connections</h4>
        <DataTable
          rows={records(topology.connections)}
          cols={[
            'id',
            'sourceComponentInstanceId',
            'sourcePortName',
            'targetComponentInstanceId',
            'targetPortName',
          ]}
        />
        <h4>Run deliveries</h4>
        <DataTable
          rows={records(topology.deliveries)}
          cols={[
            'id',
            'targetComponentInstanceId',
            'targetPortName',
            'status',
            'attemptsCount',
            'createdAt',
          ]}
        />
        <h4>Run executions</h4>
        <DataTable
          rows={records(topology.executions)}
          cols={[
            'id',
            'deliveryId',
            'componentInstanceId',
            'status',
            'lifecycleEpoch',
            'createdAt',
            'completedAt',
            'failedAt',
          ]}
        />
        <h4>Explicit relationships</h4>
        <JsonBlock value={topology.relationships} />
      </section>
    </State>
  );
}

export function RunAlertsPanel({ runId }: { runId: string }) {
  const query = useInfiniteQuery({
    queryKey: ['operator-run-alerts', runId],
    enabled: runId.length > 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      operatorClient.runAlerts(runId, { cursor: pageParam, limit: 25 }, signal),
    getNextPageParam: (lastPage: Page<InspectionRecord>) =>
      lastPage.nextCursor ?? undefined,
  });
  const alerts = pageItems(query);

  return (
    <State q={query}>
      <section>
        <h3>Current alerts</h3>
        <p className="muted">
          Alerts are projections of canonical durable conditions and disappear
          when their source condition clears.
        </p>
        <DataTable
          rows={alerts}
          cols={[
            'id',
            'severity',
            'kind',
            'title',
            'message',
            'observedAt',
            'source',
            'details',
          ]}
        />
        <LoadMore
          hasNextPage={Boolean(query.hasNextPage)}
          isFetchingNextPage={query.isFetchingNextPage}
          fetchNextPage={query.fetchNextPage}
        />
      </section>
    </State>
  );
}

export function RunEventsPanel({ runId }: { runId: string }) {
  const query = useInfiniteQuery({
    queryKey: ['operator-run-events', runId],
    enabled: runId.length > 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      operatorClient.runEvents(runId, { cursor: pageParam, limit: 25 }, signal),
    getNextPageParam: (lastPage: RunEventPage) =>
      lastPage.nextCursor ?? undefined,
  });
  const events = pageItems(query);
  const latest = query.data?.pages.at(-1);

  return (
    <State q={query}>
      <section>
        <div className="section-heading">
          <div>
            <h3>Finite run event stream</h3>
            <p className="muted">
              Ordered, resumable event pages with deduplication identity.
            </p>
          </div>
          <StatusBadge
            value={latest?.complete ? 'caught-up' : 'more-available'}
          />
        </div>
        <DataTable
          rows={events}
          cols={[
            'id',
            'eventType',
            'sourceKind',
            'sourceExecutionId',
            'sourceAttemptId',
            'sequenceNumber',
            'createdAt',
            'payload',
          ]}
        />
        <p className="muted">
          Resume cursor: <CopyId value={latest?.resumeCursor} />
        </p>
        <LoadMore
          hasNextPage={Boolean(query.hasNextPage)}
          isFetchingNextPage={query.isFetchingNextPage}
          fetchNextPage={query.fetchNextPage}
        />
      </section>
    </State>
  );
}

export function RunArtifactsPanel({ runId }: { runId: string }) {
  const query = useInfiniteQuery({
    queryKey: ['operator-run-artifacts', runId],
    enabled: runId.length > 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      operatorClient.runArtifacts(
        runId,
        { cursor: pageParam, limit: 25 },
        signal,
      ),
    getNextPageParam: (lastPage: Page<InspectionRecord>) =>
      lastPage.nextCursor ?? undefined,
  });
  const artifacts = pageItems(query);

  return (
    <State q={query}>
      <section>
        <h3>Run artifacts</h3>
        <DataTable
          rows={artifacts}
          cols={[
            'id',
            'digest',
            'schemaName',
            'schemaVersion',
            'mediaType',
            'sizeBytes',
            'state',
            'createdAt',
            'provenance',
          ]}
        />
        <LoadMore
          hasNextPage={Boolean(query.hasNextPage)}
          isFetchingNextPage={query.isFetchingNextPage}
          fetchNextPage={query.fetchNextPage}
        />
      </section>
    </State>
  );
}

export function PendingApprovals() {
  const query = useInfiniteQuery({
    queryKey: ['operator-pending-approvals'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      operatorClient.pendingApprovals({ cursor: pageParam, limit: 25 }, signal),
    getNextPageParam: (lastPage: Page<InspectionRecord>) =>
      lastPage.nextCursor ?? undefined,
  });
  const approvals = pageItems(query);

  return (
    <State q={query}>
      <section>
        <h3>Pending approvals</h3>
        <p className="muted">
          This read-only view exposes canonical approval requests. Host-specific
          decision controls remain outside the reusable package until the safe
          mutation workflow is added.
        </p>
        <DataTable
          rows={approvals}
          cols={[
            'id',
            'status',
            'policyName',
            'policyVersion',
            'subjectKind',
            'subjectId',
            'reason',
            'requestedAt',
            'normalizedInputs',
          ]}
        />
        <LoadMore
          hasNextPage={Boolean(query.hasNextPage)}
          isFetchingNextPage={query.isFetchingNextPage}
          fetchNextPage={query.fetchNextPage}
        />
      </section>
    </State>
  );
}

export function RunOperatorWorkspace({ runId }: { runId: string }) {
  if (!runId)
    return (
      <div role="alert" className="panel-state">
        A run ID is required.
      </div>
    );

  return (
    <>
      <RunStatusPanel runId={runId} />
      <RunAlertsPanel runId={runId} />
      <RunEventsPanel runId={runId} />
      <RunTopologyPanel runId={runId} />
      <RunTracePanel runId={runId} />
      <RunArtifactsPanel runId={runId} />
    </>
  );
}
