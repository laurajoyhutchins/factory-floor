import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  operatorClient,
  type InspectionRecord,
  type Page,
} from '../api/client.js';
import { JsonBlock, LoadMore, State, StatusBadge } from '../components/ui.js';

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function requestId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}-${random}`;
}

function ApprovalDecision({ approval }: { approval: InspectionRecord }) {
  const queryClient = useQueryClient();
  const approvalId = text(approval.id);
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [clientRequestId, setClientRequestId] = useState(() => requestId('approval'));
  const mutation = useMutation({
    mutationFn: () =>
      operatorClient.decideApproval(approvalId, {
        clientRequestId,
        decision,
        reason: reason.trim(),
      }),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['operator-pending-approvals'] });
    },
    onSuccess: () => {
      setConfirmed(false);
      setReason('');
      setClientRequestId(requestId('approval'));
    },
  });
  const canSubmit = approvalId.length > 0 && reason.trim().length > 0 && confirmed && !mutation.isPending;

  return (
    <article className="panel" aria-labelledby={`approval-${approvalId}`}>
      <div className="section-heading">
        <div>
          <h4 id={`approval-${approvalId}`}>Approval {approvalId}</h4>
          <p className="muted">{text(approval.reason) || 'No request reason supplied.'}</p>
        </div>
        <StatusBadge value={approval.status} />
      </div>
      <JsonBlock value={approval.normalizedInputs} />
      <label>
        Decision
        <select value={decision} onChange={(event) => setDecision(event.target.value as 'approve' | 'reject')}>
          <option value="approve">Approve</option>
          <option value="reject">Reject</option>
        </select>
      </label>
      <label>
        Reason
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
      </label>
      <label>
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        I confirm this {decision} decision and its consequences.
      </label>
      <button type="button" disabled={!canSubmit} onClick={() => mutation.mutate()}>
        {mutation.isPending ? 'Submitting…' : `Submit ${decision}`}
      </button>
      {mutation.isError ? (
        <div role="alert" className="panel-state">
          Decision outcome was not accepted locally. Canonical approval state has been re-queried; review it before retrying.
        </div>
      ) : null}
      {mutation.isSuccess ? <p role="status">Decision recorded. Canonical approval state refreshed.</p> : null}
    </article>
  );
}

export function ApprovalInterventionQueue() {
  const query = useInfiniteQuery({
    queryKey: ['operator-pending-approvals'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      operatorClient.pendingApprovals({ cursor: pageParam, limit: 25 }, signal),
    getNextPageParam: (lastPage: Page<InspectionRecord>) => lastPage.nextCursor ?? undefined,
  });
  const approvals = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );

  return (
    <State q={query}>
      <section>
        <h3>Approval interventions</h3>
        <p className="muted">
          Decisions require an explicit reason and confirmation. Mutations use the authoritative operator command boundary and canonical state is refreshed after every outcome.
        </p>
        {approvals.length ? approvals.map((approval) => <ApprovalDecision key={text(approval.id)} approval={approval} />) : <p className="muted">No pending approvals.</p>}
        <LoadMore
          hasNextPage={Boolean(query.hasNextPage)}
          isFetchingNextPage={query.isFetchingNextPage}
          fetchNextPage={query.fetchNextPage}
        />
      </section>
    </State>
  );
}

export function RunCancellationIntervention({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [clientRequestId, setClientRequestId] = useState(() => requestId('cancel'));
  const mutation = useMutation({
    mutationFn: () =>
      operatorClient.cancelRun(runId, {
        clientRequestId,
        reason: reason.trim(),
      }),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['operator-run', runId] }),
        queryClient.invalidateQueries({ queryKey: ['operator-run-alerts', runId] }),
        queryClient.invalidateQueries({ queryKey: ['operator-run-events', runId] }),
      ]);
    },
    onSuccess: () => {
      setConfirmed(false);
      setReason('');
      setClientRequestId(requestId('cancel'));
    },
  });
  const canSubmit = runId.length > 0 && reason.trim().length > 0 && confirmed && !mutation.isPending;

  return (
    <section>
      <h3>Cancel run</h3>
      <p className="muted">
        Cancellation is run-scoped. A reason and explicit confirmation are required; canonical run state is refreshed after every outcome.
      </p>
      <label>
        Reason
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
      </label>
      <label>
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        I confirm cancellation of run {runId}.
      </label>
      <button type="button" disabled={!canSubmit} onClick={() => mutation.mutate()}>
        {mutation.isPending ? 'Cancelling…' : 'Cancel run'}
      </button>
      {mutation.isError ? (
        <div role="alert" className="panel-state">
          Cancellation outcome was ambiguous or rejected. Canonical run state has been re-queried; review it before retrying.
        </div>
      ) : null}
      {mutation.isSuccess ? <p role="status">Cancellation recorded. Canonical run state refreshed.</p> : null}
    </section>
  );
}
