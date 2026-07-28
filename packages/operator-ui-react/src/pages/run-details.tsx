import { useQuery } from '@tanstack/react-query';
import type { RunDetailsPage } from '@factory-floor/operator-client-ts/run-details';
import {
  CopyId,
  JsonBlock,
  State,
  StatusBadge,
  Timestamp,
} from '../components/ui.js';

export interface RunDetailsPanelProps {
  runId: string;
  loadDetails: (runId: string) => Promise<RunDetailsPage>;
}

export function RunDetailsPanel({ runId, loadDetails }: RunDetailsPanelProps) {
  const query = useQuery({
    queryKey: ['operator-run-details', runId],
    queryFn: () => loadDetails(runId),
  });
  const details = query.data;

  return (
    <State q={query}>
      {details ? (
        <section className="panel" aria-labelledby="run-details-heading">
          <div className="section-heading">
            <div>
              <h3 id="run-details-heading">Run governance and lineage</h3>
              <p className="muted">
                Run-isolated approvals, policy outcomes, resource usage,
                artifact derivations, and aggregate control-plane projection
                freshness.
              </p>
            </div>
            <span className="badge">Bound {details.limits.records}</span>
          </div>

          <DetailTable
            title="Approvals"
            empty="No approvals are associated with this run."
            headers={['Approval', 'Action', 'Policy', 'Status', 'Requested']}
            rows={details.approvals.map((approval) => [
              <CopyId key="id" value={approval.id} />,
              <span key="action">
                {approval.actionType} · <CopyId value={approval.actionId} />
              </span>,
              <span key="policy">
                {approval.policyName}@{approval.policyVersion}
              </span>,
              <StatusBadge key="status" value={approval.status} />,
              <Timestamp key="requested" value={approval.requestedAt} />,
            ])}
          />

          <DetailTable
            title="Resource ledger"
            empty="No resource usage is associated with this run."
            headers={['Resource', 'Type', 'Quantity', 'Execution', 'Recorded']}
            rows={details.resources.map((resource) => [
              <CopyId key="id" value={resource.id} />,
              <span key="type">{resource.resourceType}</span>,
              <span key="quantity">
                {resource.quantity} {resource.unit}
              </span>,
              <CopyId key="execution" value={resource.executionId} />,
              <Timestamp key="recorded" value={resource.createdAt} />,
            ])}
          />

          <DetailTable
            title="Policy decisions"
            empty="No policy decisions are associated with this run."
            headers={['Decision', 'Policy', 'Outcome', 'Action', 'Recorded']}
            rows={details.policyDecisions.map((decision) => [
              <CopyId key="id" value={decision.id} />,
              <span key="policy">
                {decision.policyName}@{decision.policyVersion}
              </span>,
              <StatusBadge key="outcome" value={decision.outcome} />,
              <span key="action">
                {decision.actionType} · <CopyId value={decision.actionId} />
              </span>,
              <Timestamp key="recorded" value={decision.createdAt} />,
            ])}
          />

          <DetailTable
            title="Artifact derivations"
            empty="No artifact derivations are associated with this run."
            headers={[
              'Derivation',
              'Source artifact',
              'Result artifact',
              'Type',
              'Recorded',
            ]}
            rows={details.derivations.map((derivation) => [
              <CopyId key="id" value={derivation.id} />,
              <CopyId key="source" value={derivation.sourceArtifactId} />,
              <CopyId key="result" value={derivation.artifactId} />,
              <span key="type">{derivation.derivationType}</span>,
              <Timestamp key="recorded" value={derivation.createdAt} />,
            ])}
          />

          <DetailTable
            title="Control-plane projection freshness"
            empty="No control-plane projection checkpoints are available."
            headers={['Projection', 'Freshness', 'Updated']}
            rows={details.projectionFreshness.items.map((projection) => [
              <span key="projection">{projection.projectionName}</span>,
              <StatusBadge
                key="freshness"
                value={projection.stale ? 'stale' : 'fresh'}
              />,
              <Timestamp key="updated" value={projection.updatedAt} />,
            ])}
          />

          <details>
            <summary>Raw bounded run details</summary>
            <JsonBlock value={details} />
          </details>
        </section>
      ) : null}
    </State>
  );
}

function DetailTable({
  title,
  empty,
  headers,
  rows,
}: {
  title: string;
  empty: string;
  headers: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <section>
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {headers.map((header) => (
                  <th key={header} scope="col">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
