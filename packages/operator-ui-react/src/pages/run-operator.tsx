import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  operatorClient,
  type CommandEventPage,
  type InspectionRecord,
  type Page,
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

export function CommandStatusPanel({ commandId }: { commandId: string }) {
  const query = useQuery({
    queryKey: ['operator-command', commandId],
    enabled: commandId.length > 0,
    queryFn: ({ signal }) => operatorClient.command(commandId, signal),
  });
  const command = query.data ?? {};
  return (
    <State q={query}>
      <section>
        <div className="section-heading">
          <div><h3>Command status</h3><p><CopyId value={command.commandId ?? commandId} />{' '}<StatusBadge value={command.status} /></p></div>
          <Timestamp value={command.completedAt ?? command.createdAt} />
        </div>
        <DataTable rows={[command]} cols={['commandType','regionName','status','retryCount','pendingApprovalCount','createdAt','completedAt']} />
        <h4>Counts</h4><JsonBlock value={command.counts} />
        {command.blockingReason ? <><h4>Blocking reason</h4><JsonBlock value={command.blockingReason} /></> : null}
      </section>
    </State>
  );
}

export function CommandTracePanel({ commandId }: { commandId: string }) {
  const query = useQuery({ queryKey: ['operator-command-trace', commandId], enabled: commandId.length > 0, queryFn: ({ signal }) => operatorClient.commandTrace(commandId, signal) });
  const trace = query.data ?? {};
  return <State q={query}><section><h3>Bounded durable trace</h3>{[['Deliveries', trace.deliveries],['Executions', trace.executions],['Attempts', trace.attempts],['Outputs', trace.outputs],['Events', trace.events]].map(([title, value]) => { const page = record(value); return <article key={String(title)} className="panel"><div className="section-heading"><h4>{String(title)}</h4>{page.truncated ? <StatusBadge value="truncated" /> : null}</div><JsonBlock value={page.items ?? []} /></article>; })}</section></State>;
}

export function CommandTopologyPanel({ commandId }: { commandId: string }) {
  const query = useQuery({ queryKey: ['operator-command-topology', commandId], enabled: commandId.length > 0, queryFn: ({ signal }) => operatorClient.commandTopology(commandId, {}, signal) });
  const topology = query.data ?? {};
  return <State q={query}><section>
    <div className="section-heading"><div><h3>Command topology</h3><p className="muted">Immutable execution context with command-scoped runtime records.</p></div><JsonBlock value={topology.bounds} /></div>
    <h4>Regions</h4><DataTable rows={records(topology.regions)} cols={['id','name','lifecycleStatus','lifecycleEpoch']} />
    <h4>Topology revisions</h4><DataTable rows={records(topology.topologyRevisions)} cols={['id','regionId','revisionNumber','contentDigest','activatedAt']} />
    <h4>Components</h4><DataTable rows={records(topology.components)} cols={['id','regionId','topologyRevisionId','name','lifecycleStatus','definition','ports']} />
    <h4>Connections</h4><DataTable rows={records(topology.connections)} cols={['id','sourceComponentInstanceId','sourcePortName','targetComponentInstanceId','targetPortName']} />
    <h4>Command deliveries</h4><DataTable rows={records(topology.deliveries)} cols={['id','targetComponentInstanceId','targetPortName','status','attemptsCount','createdAt']} />
    <h4>Command executions</h4><DataTable rows={records(topology.executions)} cols={['id','deliveryId','componentInstanceId','status','lifecycleEpoch','createdAt','completedAt','failedAt']} />
    <h4>Explicit relationships</h4><JsonBlock value={topology.relationships} />
  </section></State>;
}

export function CommandAlertsPanel({ commandId }: { commandId: string }) {
  const query = useInfiniteQuery({ queryKey: ['operator-command-alerts', commandId], enabled: commandId.length > 0, initialPageParam: null as string | null, queryFn: ({ pageParam, signal }) => operatorClient.commandAlerts(commandId, { cursor: pageParam, limit: 25 }, signal), getNextPageParam: (lastPage: Page<InspectionRecord>) => lastPage.nextCursor ?? undefined });
  const alerts = pageItems(query);
  return <State q={query}><section><h3>Current alerts</h3><p className="muted">Alerts are projections of canonical durable conditions and disappear when their source condition clears.</p><DataTable rows={alerts} cols={['id','severity','kind','title','message','observedAt','source','details']} /><LoadMore hasNextPage={Boolean(query.hasNextPage)} isFetchingNextPage={query.isFetchingNextPage} fetchNextPage={query.fetchNextPage} /></section></State>;
}

export function CommandEventsPanel({ commandId }: { commandId: string }) {
  const query = useInfiniteQuery({ queryKey: ['operator-command-events', commandId], enabled: commandId.length > 0, initialPageParam: null as string | null, queryFn: ({ pageParam, signal }) => operatorClient.commandEvents(commandId, { cursor: pageParam, limit: 25 }, signal), getNextPageParam: (lastPage: CommandEventPage) => lastPage.nextCursor ?? undefined });
  const events = pageItems(query); const latest = query.data?.pages.at(-1);
  return <State q={query}><section><div className="section-heading"><div><h3>Finite command event stream</h3><p className="muted">Ordered, resumable event pages with deduplication identity.</p></div><StatusBadge value={latest?.complete ? 'caught-up' : 'more-available'} /></div><DataTable rows={events} cols={['id','eventType','sourceKind','sourceExecutionId','sourceAttemptId','sequenceNumber','createdAt','payload']} /><p className="muted">Resume cursor: <CopyId value={latest?.resumeCursor} /></p><LoadMore hasNextPage={Boolean(query.hasNextPage)} isFetchingNextPage={query.isFetchingNextPage} fetchNextPage={query.fetchNextPage} /></section></State>;
}

export function CommandArtifactsPanel({ commandId }: { commandId: string }) {
  const query = useInfiniteQuery({ queryKey: ['operator-command-artifacts', commandId], enabled: commandId.length > 0, initialPageParam: null as string | null, queryFn: ({ pageParam, signal }) => operatorClient.commandArtifacts(commandId, { cursor: pageParam, limit: 25 }, signal), getNextPageParam: (lastPage: Page<InspectionRecord>) => lastPage.nextCursor ?? undefined });
  const artifacts = pageItems(query);
  return <State q={query}><section><h3>Command artifacts</h3><DataTable rows={artifacts} cols={['id','digest','schemaName','schemaVersion','mediaType','sizeBytes','state','createdAt','provenance']} /><LoadMore hasNextPage={Boolean(query.hasNextPage)} isFetchingNextPage={query.isFetchingNextPage} fetchNextPage={query.fetchNextPage} /></section></State>;
}

export function PendingApprovals() {
  const query = useInfiniteQuery({ queryKey: ['operator-pending-approvals'], initialPageParam: null as string | null, queryFn: ({ pageParam, signal }) => operatorClient.pendingApprovals({ cursor: pageParam, limit: 25 }, signal), getNextPageParam: (lastPage: Page<InspectionRecord>) => lastPage.nextCursor ?? undefined });
  const approvals = pageItems(query);
  return <State q={query}><section><h3>Pending approvals</h3><p className="muted">This read-only view exposes canonical approval requests. Host-specific decision controls remain outside the reusable package until the safe mutation workflow is added.</p><DataTable rows={approvals} cols={['id','status','policyName','policyVersion','subjectKind','subjectId','reason','requestedAt','normalizedInputs']} /><LoadMore hasNextPage={Boolean(query.hasNextPage)} isFetchingNextPage={query.isFetchingNextPage} fetchNextPage={query.fetchNextPage} /></section></State>;
}

export function CommandOperatorWorkspace({ commandId }: { commandId: string }) {
  if (!commandId) return <div role="alert" className="panel-state">A command ID is required.</div>;
  return <><CommandStatusPanel commandId={commandId} /><CommandAlertsPanel commandId={commandId} /><CommandEventsPanel commandId={commandId} /><CommandTopologyPanel commandId={commandId} /><CommandTracePanel commandId={commandId} /><CommandArtifactsPanel commandId={commandId} /></>;
}