import { useQuery } from '@tanstack/react-query';
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Link, useParams } from 'react-router';
import { consoleApi } from '../api/client.js';
import { normalize } from '../api/adapters.js';
import {
  Badge,
  CopyId,
  DataTable,
  JsonBlock,
  State,
} from '../components/ui.js';

const asItems = (v: unknown) =>
  ((v as { items?: unknown[] })?.items ?? []).map(
    (x) => normalize(x) as Record<string, unknown>,
  );
const rec = (v: unknown) =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const arr = (v: unknown) =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
export function Overview() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => consoleApi.health(signal),
    retry: 1,
  });
  const projections = useQuery({
    queryKey: ['projections'],
    queryFn: ({ signal }) => consoleApi.projections(signal),
  });
  const events = useQuery({
    queryKey: ['events'],
    queryFn: ({ signal }) => consoleApi.events({ limit: 8 }, signal),
  });
  return (
    <>
      <section className="cards">
        <article>
          <h3>Control plane</h3>
          <Badge>
            {health.data?.status ??
              (health.isError ? 'disconnected' : 'checking')}
          </Badge>
        </article>
        {asItems(projections.data).map((p) => (
          <article key={String(p.projectionName)}>
            <h3>{String(p.projectionName)}</h3>
            <p>seq {String(p.lastSequenceNumber ?? '0')}</p>
            <p>
              {p.stalenessMs == null
                ? 'not checkpointed'
                : `${p.stalenessMs}ms stale`}
            </p>
          </article>
        ))}
      </section>
      <section>
        <h3>Recent runtime events</h3>
        <State q={events}>
          <DataTable
            rows={asItems(events.data)}
            cols={['id', 'eventType', 'regionId', 'sourceKind', 'createdAt']}
          />
        </State>
      </section>
    </>
  );
}
export function Topology() {
  const q = useQuery({
    queryKey: ['topology'],
    queryFn: ({ signal }) => consoleApi.topology(signal),
  });
  const topo = (normalize(q.data) ?? {}) as {
    regions?: Record<string, unknown>[];
    components?: Record<string, unknown>[];
    connections?: Record<string, unknown>[];
  };
  const nodes: Node[] = (topo.components ?? []).map((c, i) => ({
    id: String(c.id),
    position: { x: (i % 4) * 220, y: Math.floor(i / 4) * 140 },
    data: {
      label: (
        <>
          <strong>{String(c.name)}</strong>
          <br />
          <small>{String(rec(c.definition).name ?? '')}</small>
          <br />
          <Badge>{String(c.lifecycleStatus)}</Badge>
        </>
      ),
    },
  }));
  const edges: Edge[] = (topo.connections ?? []).map((c) => ({
    id: String(c.id),
    source: String(c.sourceComponentId),
    target: String(c.targetComponentId),
    label: `${String(c.sourcePortName)} → ${String(c.targetPortName)}`,
    animated: false,
  }));
  return (
    <State q={q}>
      <section className="split">
        <div className="graph" aria-label="Active topology graph">
          <ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false}>
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        <aside className="panel">
          <h3>Topology summary</h3>
          <p>
            {topo.regions?.length ?? 0} regions, {nodes.length} components,{' '}
            {edges.length} connections.
          </p>
          <ul>
            {(topo.regions ?? []).map((r) => (
              <li key={String(r.id)}>
                {String(r.name)} <Badge>{String(r.lifecycleStatus)}</Badge> rev{' '}
                {String(rec(r.activeTopologyRevision).revisionNumber ?? '')}
              </li>
            ))}
          </ul>
        </aside>
      </section>
    </State>
  );
}
export function Executions() {
  const q = useQuery({
    queryKey: ['executions'],
    queryFn: ({ signal }) => consoleApi.executions({ limit: 50 }, signal),
  });
  const rows = asItems(q.data);
  return (
    <State q={q}>
      <DataTable
        rows={rows}
        cols={[
          'id',
          'componentInstanceId',
          'regionId',
          'status',
          'lifecycleEpoch',
          'createdAt',
          'completedAt',
          'failedAt',
        ]}
      />
      {rows.map((r) => (
        <p key={String(r.id)}>
          <Link to={`/executions/${String(r.id)}`}>
            Open trace {String(r.id).slice(0, 8)}
          </Link>
        </p>
      ))}
    </State>
  );
}
export function ExecutionDetail() {
  const { executionId = '' } = useParams();
  const q = useQuery({
    queryKey: ['execution', executionId],
    queryFn: ({ signal }) => consoleApi.execution(executionId, signal),
    retry: false,
  });
  const data = rec(normalize(q.data));
  const chain = rec(data.causalChain);
  const attempts = arr(chain.attempts);
  return (
    <State q={q}>
      <h3>
        Execution trace <CopyId value={executionId} />
      </h3>
      <JsonBlock value={chain.command ?? chain.sourceEvent} />
      <ol className="timeline">
        {attempts.map((a) => (
          <li key={String(a.id)}>
            <Badge>
              attempt {String(a.attemptNumber)} {String(a.status)}
            </Badge>
            {Number(a.attemptNumber) > 1 && (
              <strong> replacement attempt</strong>
            )}
            <JsonBlock value={a.failure} />
          </li>
        ))}
      </ol>
      <h4>Outputs and downstream effects</h4>
      <JsonBlock
        value={{
          outputs: chain.outputs,
          events: chain.events,
          downstreamDeliveries: chain.downstreamDeliveries,
        }}
      />
    </State>
  );
}
export function Artifacts() {
  const q = useQuery({
    queryKey: ['artifacts'],
    queryFn: ({ signal }) => consoleApi.artifacts({ limit: 50 }, signal),
  });
  const rows = asItems(q.data);
  return (
    <State q={q}>
      <DataTable
        rows={rows}
        cols={[
          'id',
          'digest',
          'schemaName',
          'schemaVersion',
          'mediaType',
          'sizeBytes',
          'state',
          'createdAt',
          'tombstonedAt',
        ]}
      />
      {rows.map((r) => (
        <p key={String(r.id)}>
          <Link to={`/artifacts/${String(r.id)}`}>
            Open lineage {String(r.id).slice(0, 8)}
          </Link>
        </p>
      ))}
    </State>
  );
}
export function ArtifactDetail() {
  const { artifactId = '' } = useParams();
  const q = useQuery({
    queryKey: ['artifact', artifactId],
    queryFn: ({ signal }) => consoleApi.artifactLineage(artifactId, signal),
    retry: false,
  });
  const data = rec(normalize(q.data));
  const derivs = arr(data.derivations);
  const nodes: Node[] = [
    data.artifact,
    ...derivs.map((d) => ({ id: d.artifactId ?? d.sourceArtifactId })),
  ]
    .filter(Boolean)
    .map((a, i) => ({
      id: String(rec(a).id),
      position: { x: i * 180, y: (i % 2) * 120 },
      data: { label: String(rec(a).id).slice(0, 8) },
    }));
  return (
    <State q={q}>
      <h3>
        Artifact <CopyId value={artifactId} />
      </h3>
      <JsonBlock value={data.artifact} />
      <div className="graph small">
        <ReactFlow nodes={nodes} edges={[]} fitView>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      <h4>Derivations</h4>
      <DataTable
        rows={derivs}
        cols={[
          'id',
          'sourceArtifactId',
          'artifactId',
          'executionId',
          'attemptId',
          'createdAt',
        ]}
      />
    </State>
  );
}
export function Operations() {
  const qs = {
    deliveries: useQuery({
      queryKey: ['deliveries'],
      queryFn: ({ signal }) => consoleApi.deliveries({ limit: 25 }, signal),
    }),
    attempts: useQuery({
      queryKey: ['attempts'],
      queryFn: ({ signal }) => consoleApi.attempts({ limit: 25 }, signal),
    }),
    resources: useQuery({
      queryKey: ['resources'],
      queryFn: ({ signal }) => consoleApi.resources({ limit: 25 }, signal),
    }),
    policies: useQuery({
      queryKey: ['policies'],
      queryFn: ({ signal }) =>
        consoleApi.policyDecisions({ limit: 25 }, signal),
    }),
    projections: useQuery({
      queryKey: ['projections'],
      queryFn: ({ signal }) => consoleApi.projections(signal),
    }),
  };
  return (
    <>
      {Object.entries(qs).map(([name, q]) => (
        <section key={name}>
          <h3>{name}</h3>
          <State q={q}>
            <DataTable
              rows={asItems(q.data)}
              cols={Object.keys(
                asItems(q.data)[0] ?? { status: '', id: '' },
              ).slice(0, 8)}
            />
          </State>
        </section>
      ))}
    </>
  );
}
export function NotFound() {
  return <p role="alert">Console route not found.</p>;
}
