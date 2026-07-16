import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  consoleApi,
  type InspectionRecord,
  type Page,
  type PageOptions,
} from '../api/client.js';
import {
  Badge,
  CopyId,
  DataTable,
  JsonBlock,
  LoadMore,
  State,
  StatusBadge,
  Timestamp,
} from '../components/ui.js';
import type { RuntimeEvent, StreamState } from '../hooks/liveEvents.js';

const rec = (value: unknown): InspectionRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as InspectionRecord)
    : {};
const arr = (value: unknown): InspectionRecord[] =>
  Array.isArray(value) ? value.map(rec) : [];
const text = (value: unknown, fallback = '—') =>
  value === null || value === undefined || value === ''
    ? fallback
    : String(value);

function usePagedInspection(
  key: string,
  loader: (
    options?: PageOptions,
    signal?: AbortSignal,
  ) => Promise<Page<InspectionRecord>>,
  limit = 25,
) {
  return useInfiniteQuery({
    queryKey: [key, limit],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      loader({ cursor: pageParam, limit }, signal),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

type PagedInspectionQuery = ReturnType<typeof usePagedInspection>;

function pagedRows(query: PagedInspectionQuery): InspectionRecord[] {
  return query.data?.pages.flatMap((page) => page.items) ?? [];
}

function formatCounts(value: unknown) {
  const entries = Object.entries(rec(value));
  return entries.length
    ? entries.map(([key, count]) => `${key}: ${String(count)}`).join(' · ')
    : 'No records';
}

function MetricCard({
  title,
  value,
  detail,
}: {
  title: string;
  value: string;
  detail?: string;
}) {
  return (
    <article className="metric-card">
      <h3>{title}</h3>
      <p className="metric-value">{value}</p>
      {detail ? <p className="muted">{detail}</p> : null}
    </article>
  );
}

export function Overview({
  healthStatus = 'checking',
  liveEvents = [],
  liveState = 'connecting',
}: {
  healthStatus?: string;
  liveEvents?: RuntimeEvent[];
  liveState?: StreamState;
} = {}) {
  const projections = useQuery({
    queryKey: ['projections'],
    queryFn: ({ signal }) => consoleApi.projections(signal),
  });
  const recentEvents = useQuery({
    queryKey: ['events', 'recent'],
    queryFn: ({ signal }) => consoleApi.events({ limit: 12 }, signal),
  });

  const projectionItems = projections.data?.items ?? [];
  const byName = new Map(
    projectionItems.map((item) => [String(item.projectionName), item]),
  );
  const queue = rec(rec(byName.get('queue-depth')).snapshot);
  const executionAttempt = rec(
    rec(byName.get('execution-attempt-status')).snapshot,
  );
  const retries = rec(rec(byName.get('retry-failure-counts')).snapshot);
  const lineage = rec(rec(byName.get('artifact-lineage')).snapshot);
  const resources = rec(rec(byName.get('resource-usage')).snapshot);
  const resourceTotals = arr(resources.totals);
  const uncheckpointed = projectionItems.filter(
    (item) => item.updatedAt === null || item.updatedAt === undefined,
  ).length;
  const maximumStaleness = projectionItems.reduce(
    (maximum, item) =>
      item.stalenessMs === null || item.stalenessMs === undefined
        ? maximum
        : Math.max(maximum, Number(item.stalenessMs)),
    0,
  );
  const displayedEvents = liveEvents.length
    ? liveEvents.map(rec)
    : (recentEvents.data?.items ?? []);

  return (
    <>
      <State q={projections}>
        <section className="cards" aria-label="Runtime summary">
          <MetricCard
            title="Control plane"
            value={healthStatus}
            detail={`event stream: ${liveState}`}
          />
          <MetricCard
            title="Delivery queue"
            value={formatCounts(queue.counts)}
          />
          <MetricCard
            title="Executions"
            value={formatCounts(executionAttempt.executions)}
            detail={`attempts · ${formatCounts(executionAttempt.attempts)}`}
          />
          <MetricCard
            title="Retries and failures"
            value={`${text(retries.failedAttempts, '0')} failed attempts`}
            detail={`${text(retries.replacementAttempts, '0')} replacements · ${text(retries.deadLetteredDeliveries, '0')} dead letters`}
          />
          <MetricCard
            title="Artifact lineage"
            value={`${text(lineage.artifacts, '0')} artifacts`}
            detail={`${text(lineage.derivations, '0')} derivations`}
          />
          <MetricCard
            title="Projection freshness"
            value={
              uncheckpointed
                ? `${uncheckpointed} uncheckpointed`
                : 'checkpointed'
            }
            detail={`maximum reported staleness ${maximumStaleness} ms`}
          />
        </section>
        <section>
          <h3>Recorded resource use</h3>
          {resourceTotals.length ? (
            <DataTable
              rows={resourceTotals}
              cols={['resourceType', 'quantity', 'unit']}
              labels={{
                resourceType: 'Resource',
                quantity: 'Quantity',
                unit: 'Unit',
              }}
            />
          ) : (
            <p className="muted">No resource entries recorded yet.</p>
          )}
        </section>
      </State>
      <section>
        <div className="section-heading">
          <h3>Recent runtime events</h3>
          <StatusBadge value={liveState} />
        </div>
        {liveEvents.length ? (
          <DataTable
            rows={displayedEvents}
            cols={['id', 'eventType', 'regionId', 'sourceKind', 'createdAt']}
          />
        ) : (
          <State q={recentEvents}>
            <DataTable
              rows={displayedEvents}
              cols={['id', 'eventType', 'regionId', 'sourceKind', 'createdAt']}
            />
          </State>
        )}
      </section>
    </>
  );
}

export function buildTopologyGraph(topology: InspectionRecord) {
  const regions = arr(topology.regions);
  const components = arr(topology.components);
  const connections = arr(topology.connections);
  const regionOrder = new Map(
    regions.map((region, index) => [String(region.id), index]),
  );
  const regionNames = new Map(
    regions.map((region) => [String(region.id), text(region.name)]),
  );
  const nextRow = new Map<string, number>();

  const nodes: Node[] = components.map((component) => {
    const regionId = String(component.regionId ?? 'unassigned');
    const row = nextRow.get(regionId) ?? 0;
    nextRow.set(regionId, row + 1);
    const definition = rec(component.definition);
    const ports = arr(component.ports);
    return {
      id: String(component.id),
      position: {
        x: (regionOrder.get(regionId) ?? regionOrder.size) * 340,
        y: row * 170,
      },
      data: {
        label: (
          <div className="topology-node">
            <strong>{text(component.name)}</strong>
            <small>{`${text(definition.name)}@${text(definition.version)}`}</small>
            <small>{regionNames.get(regionId) ?? regionId}</small>
            <StatusBadge value={component.lifecycleStatus} />
            <small>{ports.map((port) => text(port.name)).join(' · ')}</small>
          </div>
        ),
      },
    };
  });

  const edges: Edge[] = connections.map((connection) => ({
    id: String(connection.id),
    source: String(connection.sourceComponentId),
    target: String(connection.targetComponentId),
    label: `${text(connection.sourcePortName)} → ${text(connection.targetPortName)}`,
  }));

  return { regions, components, connections, nodes, edges };
}

export function Topology() {
  const query = useQuery({
    queryKey: ['topology'],
    queryFn: ({ signal }) => consoleApi.topology(signal),
  });
  const graph = useMemo(
    () => buildTopologyGraph(query.data ?? {}),
    [query.data],
  );
  const [selectedComponentId, setSelectedComponentId] = useState<string>();
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>();
  const selectedComponent = graph.components.find(
    (component) => String(component.id) === selectedComponentId,
  );
  const selectedConnection = graph.connections.find(
    (connection) => String(connection.id) === selectedConnectionId,
  );

  return (
    <State q={query}>
      <section className="split">
        <div className="graph" aria-label="Active topology graph">
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            fitView
            nodesDraggable={false}
            nodesFocusable
            edgesFocusable
            onNodeClick={(_event, node) => {
              setSelectedComponentId(node.id);
              setSelectedConnectionId(undefined);
            }}
            onEdgeClick={(_event, edge) => {
              setSelectedConnectionId(edge.id);
              setSelectedComponentId(undefined);
            }}
            onPaneClick={() => {
              setSelectedComponentId(undefined);
              setSelectedConnectionId(undefined);
            }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        <aside className="panel detail-panel" aria-live="polite">
          <h3>Topology inspection</h3>
          <p>
            {graph.regions.length} regions, {graph.nodes.length} components,{' '}
            {graph.edges.length} connections.
          </p>
          {selectedComponent ? (
            <>
              <h4>Selected component</h4>
              <JsonBlock value={selectedComponent} />
            </>
          ) : selectedConnection ? (
            <>
              <h4>Selected connection</h4>
              <JsonBlock value={selectedConnection} />
            </>
          ) : (
            <p className="muted">Select a graph node or edge for details.</p>
          )}
        </aside>
      </section>
      <section>
        <h3>Text topology</h3>
        {graph.regions.map((region) => (
          <article key={String(region.id)} className="topology-region">
            <h4>
              {text(region.name)} <StatusBadge value={region.lifecycleStatus} />
            </h4>
            <p>
              lifecycle epoch {text(region.lifecycleEpoch)} · revision{' '}
              {text(rec(region.activeTopologyRevision).revisionNumber)}
            </p>
            <ul>
              {graph.components
                .filter(
                  (component) =>
                    String(component.regionId) === String(region.id),
                )
                .map((component) => (
                  <li key={String(component.id)}>
                    <button
                      type="button"
                      className="text-select"
                      onClick={() => {
                        setSelectedComponentId(String(component.id));
                        setSelectedConnectionId(undefined);
                      }}
                    >
                      {text(component.name)}
                    </button>{' '}
                    <StatusBadge value={component.lifecycleStatus} /> · ports{' '}
                    {arr(component.ports)
                      .map(
                        (port) => `${text(port.direction)}:${text(port.name)}`,
                      )
                      .join(', ')}
                  </li>
                ))}
            </ul>
          </article>
        ))}
        <h4>Connections</h4>
        <ul>
          {graph.connections.map((connection) => (
            <li key={String(connection.id)}>
              <button
                type="button"
                className="text-select"
                onClick={() => {
                  setSelectedConnectionId(String(connection.id));
                  setSelectedComponentId(undefined);
                }}
              >
                {text(connection.sourceComponentId)}:
                {text(connection.sourcePortName)}
                {' → '}
                {text(connection.targetComponentId)}:
                {text(connection.targetPortName)}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </State>
  );
}

export function Executions() {
  const query = usePagedInspection('executions', consoleApi.executions, 25);
  const attempts = useQuery({
    queryKey: ['attempts', 'execution-summary'],
    queryFn: ({ signal }) => consoleApi.attempts({ limit: 100 }, signal),
  });
  const [status, setStatus] = useState('all');
  const rows = pagedRows(query);
  const attemptCounts = new Map<string, number>();
  for (const attempt of attempts.data?.items ?? []) {
    const executionId = String(attempt.executionId);
    attemptCounts.set(executionId, (attemptCounts.get(executionId) ?? 0) + 1);
  }
  const filtered =
    status === 'all'
      ? rows
      : rows.filter((execution) => String(execution.status) === status);
  const statuses = [
    ...new Set(rows.map((execution) => String(execution.status))),
  ];

  return (
    <State q={query}>
      <section>
        <div className="toolbar">
          <label>
            Status in loaded records{' '}
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">all</option>
              {statuses.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <span className="muted">
            Showing {filtered.length} loaded executions
          </span>
        </div>
        {filtered.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Execution</th>
                  <th scope="col">Component</th>
                  <th scope="col">Region</th>
                  <th scope="col">Status</th>
                  <th scope="col">Epoch</th>
                  <th scope="col">Retries</th>
                  <th scope="col">Created</th>
                  <th scope="col">Finished</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((execution) => {
                  const id = String(execution.id);
                  const count = attemptCounts.get(id) ?? 0;
                  return (
                    <tr key={id}>
                      <td>
                        <Link to={`/executions/${id}`}>
                          <CopyId value={id} />
                        </Link>
                      </td>
                      <td>
                        <CopyId value={execution.componentInstanceId} />
                      </td>
                      <td>
                        <CopyId value={execution.regionId} />
                      </td>
                      <td>
                        <StatusBadge value={execution.status} />
                      </td>
                      <td>{text(execution.lifecycleEpoch)}</td>
                      <td>{Math.max(0, count - 1)}</td>
                      <td>
                        <Timestamp value={execution.createdAt} />
                      </td>
                      <td>
                        <Timestamp
                          value={execution.completedAt ?? execution.failedAt}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No loaded executions match this status.</p>
        )}
        <LoadMore
          hasNextPage={Boolean(query.hasNextPage)}
          isFetchingNextPage={query.isFetchingNextPage}
          fetchNextPage={query.fetchNextPage}
        />
      </section>
    </State>
  );
}

export function ExecutionDetail() {
  const { executionId = '' } = useParams();
  const query = useQuery({
    queryKey: ['execution', executionId],
    queryFn: ({ signal }) => consoleApi.execution(executionId, signal),
    retry: false,
  });
  const data = rec(query.data);
  const execution = rec(data.execution);
  const chain = rec(data.causalChain);
  const attempts = arr(chain.attempts);

  return (
    <State q={query}>
      <p>
        <Link to="/executions">← Back to executions</Link>
      </p>
      <section>
        <div className="section-heading">
          <h3>
            Execution <CopyId value={executionId} />
          </h3>
          <StatusBadge value={execution.status} />
        </div>
        <DataTable
          rows={[execution]}
          cols={[
            'componentInstanceId',
            'regionId',
            'lifecycleEpoch',
            'createdAt',
            'completedAt',
            'failedAt',
          ]}
        />
      </section>
      <section className="detail-grid">
        <article>
          <h3>Origin</h3>
          <JsonBlock value={chain.command ?? chain.sourceEvent} />
        </article>
        <article>
          <h3>Delivery</h3>
          <JsonBlock value={chain.delivery} />
        </article>
        <article>
          <h3>Component</h3>
          <JsonBlock value={chain.component} />
        </article>
      </section>
      <section>
        <h3>Attempt timeline</h3>
        {attempts.length ? (
          <ol className="timeline">
            {attempts.map((attempt) => (
              <li
                key={String(attempt.id)}
                data-status={String(attempt.status).toLowerCase()}
              >
                <div className="section-heading">
                  <strong>Attempt {text(attempt.attemptNumber)}</strong>
                  <StatusBadge value={attempt.status} />
                </div>
                {Number(attempt.attemptNumber) > 1 ? (
                  <p>
                    <strong>Replacement attempt</strong>
                  </p>
                ) : null}
                <p>
                  Started <Timestamp value={attempt.startedAt} /> · finished{' '}
                  <Timestamp value={attempt.completedAt} />
                </p>
                {attempt.failure ? <JsonBlock value={attempt.failure} /> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No attempts recorded.</p>
        )}
      </section>
      <section>
        <h3>Inputs</h3>
        <DataTable
          rows={arr(chain.inputs)}
          cols={['id', 'portName', 'artifactId']}
        />
      </section>
      <section>
        <h3>Outputs</h3>
        <DataTable
          rows={arr(chain.outputs)}
          cols={['id', 'portName', 'artifactId']}
        />
      </section>
      <section>
        <h3>Emitted events</h3>
        <DataTable
          rows={arr(chain.events)}
          cols={['id', 'eventType', 'sourcePortName', 'createdAt']}
        />
      </section>
      <section>
        <h3>Downstream deliveries</h3>
        <DataTable
          rows={arr(chain.downstreamDeliveries)}
          cols={[
            'id',
            'targetComponentInstanceId',
            'targetPortName',
            'status',
            'createdAt',
          ]}
        />
      </section>
    </State>
  );
}

export function Artifacts() {
  const query = usePagedInspection('artifacts', consoleApi.artifacts, 25);
  const rows = pagedRows(query);
  return (
    <State q={query}>
      <section>
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Artifact</th>
                  <th scope="col">Digest</th>
                  <th scope="col">Schema</th>
                  <th scope="col">Media type</th>
                  <th scope="col">Bytes</th>
                  <th scope="col">State</th>
                  <th scope="col">Created</th>
                  <th scope="col">Tombstone</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((artifact) => {
                  const id = String(artifact.id);
                  return (
                    <tr key={id}>
                      <td>
                        <Link to={`/artifacts/${id}`}>
                          <CopyId value={id} />
                        </Link>
                      </td>
                      <td>
                        <CopyId value={artifact.digest} />
                      </td>
                      <td>
                        {text(artifact.schemaName)}@
                        {text(artifact.schemaVersion)}
                      </td>
                      <td>{text(artifact.mediaType)}</td>
                      <td>{text(artifact.sizeBytes)}</td>
                      <td>
                        <StatusBadge value={artifact.state} />
                      </td>
                      <td>
                        <Timestamp value={artifact.createdAt} />
                      </td>
                      <td>
                        <Timestamp value={artifact.tombstonedAt} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No artifacts recorded.</p>
        )}
        <LoadMore
          hasNextPage={Boolean(query.hasNextPage)}
          isFetchingNextPage={query.isFetchingNextPage}
          fetchNextPage={query.fetchNextPage}
        />
      </section>
    </State>
  );
}

export function buildLineageGraph(data: InspectionRecord) {
  const artifact = rec(data.artifact);
  const derivations = arr(data.derivations);
  const identities = new Set<string>();
  if (artifact.id) identities.add(String(artifact.id));
  for (const derivation of derivations) {
    if (derivation.sourceArtifactId)
      identities.add(String(derivation.sourceArtifactId));
    if (derivation.artifactId) identities.add(String(derivation.artifactId));
  }
  const sorted = [...identities].sort();
  const nodes: Node[] = sorted.map((id, index) => ({
    id,
    position: { x: (index % 4) * 220, y: Math.floor(index / 4) * 140 },
    data: {
      label:
        id === String(artifact.id)
          ? `selected · ${id.slice(0, 8)}`
          : id.slice(0, 8),
    },
    className: id === String(artifact.id) ? 'selected-node' : undefined,
  }));
  const edges: Edge[] = derivations.flatMap((derivation, index) => {
    const source = derivation.sourceArtifactId;
    const target = derivation.artifactId;
    if (!source || !target) return [];
    return [
      {
        id: String(derivation.id ?? `derivation-${index}`),
        source: String(source),
        target: String(target),
        label: derivation.executionId
          ? `execution ${String(derivation.executionId).slice(0, 8)}`
          : 'derived from',
      },
    ];
  });
  return { artifact, derivations, nodes, edges };
}

export function ArtifactDetail() {
  const { artifactId = '' } = useParams();
  const query = useQuery({
    queryKey: ['artifact', artifactId],
    queryFn: ({ signal }) => consoleApi.artifactLineage(artifactId, signal),
    retry: false,
  });
  const lineage = useMemo(
    () => buildLineageGraph(query.data ?? {}),
    [query.data],
  );

  return (
    <State q={query}>
      <p>
        <Link to="/artifacts">← Back to artifacts</Link>
      </p>
      <section>
        <h3>
          Artifact <CopyId value={artifactId} />
        </h3>
        <DataTable
          rows={[lineage.artifact]}
          cols={[
            'digestAlgorithm',
            'digest',
            'schemaId',
            'state',
            'mediaType',
            'sizeBytes',
            'createdAt',
            'tombstonedAt',
          ]}
        />
        <h4>Provenance</h4>
        <JsonBlock value={lineage.artifact.provenance} />
        <p>
          Committed locator status:{' '}
          <Badge>
            {lineage.artifact.committedLocator ? 'recorded' : 'not recorded'}
          </Badge>
        </p>
      </section>
      <section>
        <h3>Lineage graph</h3>
        {lineage.nodes.length ? (
          <div className="graph small" aria-label="Artifact lineage graph">
            <ReactFlow
              nodes={lineage.nodes}
              edges={lineage.edges}
              fitView
              nodesDraggable={false}
              nodesFocusable
              edgesFocusable
            >
              <Background />
              <Controls />
            </ReactFlow>
          </div>
        ) : (
          <p className="muted">No lineage nodes recorded.</p>
        )}
        <h4>Text relationships</h4>
        {lineage.derivations.length ? (
          <ul>
            {lineage.derivations.map((derivation) => (
              <li key={String(derivation.id)}>
                <CopyId value={derivation.sourceArtifactId} /> →{' '}
                <CopyId value={derivation.artifactId} /> via execution{' '}
                <CopyId value={derivation.executionId} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No derivation relationships recorded.</p>
        )}
        <DataTable
          rows={lineage.derivations}
          cols={[
            'id',
            'sourceArtifactId',
            'artifactId',
            'executionId',
            'attemptId',
            'createdAt',
          ]}
        />
      </section>
    </State>
  );
}

function OperationSection({
  title,
  query,
  columns,
}: {
  title: string;
  query: PagedInspectionQuery;
  columns: string[];
}) {
  const rows = pagedRows(query);
  return (
    <section>
      <h3>{title}</h3>
      <State q={query}>
        <DataTable rows={rows} cols={columns} />
        <LoadMore
          hasNextPage={Boolean(query.hasNextPage)}
          isFetchingNextPage={query.isFetchingNextPage}
          fetchNextPage={query.fetchNextPage}
        />
      </State>
    </section>
  );
}

export function Operations() {
  const deliveries = usePagedInspection('deliveries', consoleApi.deliveries);
  const attempts = usePagedInspection('attempts', consoleApi.attempts);
  const resources = usePagedInspection('resources', consoleApi.resources);
  const policies = usePagedInspection(
    'policy-decisions',
    consoleApi.policyDecisions,
  );
  const projections = useQuery({
    queryKey: ['projections'],
    queryFn: ({ signal }) => consoleApi.projections(signal),
  });

  return (
    <>
      <OperationSection
        title="Deliveries"
        query={deliveries}
        columns={[
          'id',
          'regionId',
          'targetComponentInstanceId',
          'targetPortName',
          'status',
          'attemptsCount',
          'availableAt',
          'createdAt',
        ]}
      />
      <OperationSection
        title="Attempts"
        query={attempts}
        columns={[
          'id',
          'executionId',
          'attemptNumber',
          'status',
          'leaseOwner',
          'leaseExpiresAt',
          'startedAt',
          'completedAt',
          'failure',
        ]}
      />
      <OperationSection
        title="Resource ledger"
        query={resources}
        columns={[
          'id',
          'regionId',
          'executionId',
          'attemptId',
          'externalActionId',
          'resourceType',
          'quantity',
          'unit',
          'createdAt',
        ]}
      />
      <OperationSection
        title="Policy decisions"
        query={policies}
        columns={[
          'id',
          'policyName',
          'policyVersion',
          'evaluatorVersion',
          'subjectKind',
          'subjectId',
          'outcome',
          'reason',
          'modifications',
          'approvalStatus',
          'createdAt',
        ]}
      />
      <section>
        <h3>Projection checkpoints</h3>
        <State q={projections}>
          <DataTable
            rows={projections.data?.items ?? []}
            cols={[
              'projectionName',
              'checkpointId',
              'lastEventId',
              'lastSequenceNumber',
              'updatedAt',
              'stalenessMs',
              'projectorVersion',
            ]}
          />
        </State>
      </section>
    </>
  );
}

export function NotFound() {
  return (
    <div role="alert" className="panel-state">
      <p>Console route not found.</p>
      <Link to="/">Return to overview</Link>
    </div>
  );
}
