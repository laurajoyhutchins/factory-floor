import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { ApiError } from '../api/client.js';
import { shortId } from '../api/adapters.js';

export function JsonBlock({ value }: { value: unknown }) {
  const text = value === undefined ? '(not recorded)' : JSON.stringify(value, null, 2);
  return <pre className="json">{text}</pre>;
}

export function Badge({ children }: { children: ReactNode }) {
  return <span className="badge">{children}</span>;
}

export function StatusBadge({ value }: { value: unknown }) {
  const status = String(value ?? 'unknown');
  return (
    <span className="badge status" data-status={status.toLowerCase()}>
      {status}
    </span>
  );
}

export function CopyId({ value }: { value: unknown }) {
  const text = String(value ?? '');
  return (
    <button
      type="button"
      className="copy"
      onClick={() => void navigator.clipboard?.writeText(text)}
      aria-label={`Copy ${text}`}
      title={text}
    >
      {shortId(text)}
    </button>
  );
}

export function Timestamp({ value }: { value: unknown }) {
  if (!value) return <span className="muted">—</span>;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return <span>{String(value)}</span>;
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()}>
      {date.toLocaleString()}
    </time>
  );
}

export function State({
  q,
  children,
}: {
  q: {
    isLoading?: boolean;
    isPending?: boolean;
    isFetching?: boolean;
    error?: unknown;
    data?: unknown;
    refetch?: () => unknown;
  };
  children: ReactNode;
}) {
  if ((q.isLoading || q.isPending) && q.data === undefined)
    return <p className="muted">Loading…</p>;
  if (q.error) {
    const notFound = q.error instanceof ApiError && q.error.kind === 'not-found';
    const message = notFound
      ? 'The selected record was not found.'
      : q.error instanceof ApiError
        ? q.error.message
        : 'Unable to load this panel.';
    return (
      <div role="alert" className="error panel-state">
        <p>{message}</p>
        {!notFound && q.refetch ? (
          <button type="button" onClick={() => void q.refetch?.()}>
            Retry safe read
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <>
      {q.isFetching && q.data !== undefined ? (
        <p className="refreshing" role="status">
          Refreshing…
        </p>
      ) : null}
      {children}
    </>
  );
}

export function Shell({
  children,
  title,
  live,
  controlPlane,
  lastRefreshed,
}: {
  children: ReactNode;
  title: string;
  live: string;
  controlPlane: string;
  lastRefreshed?: number;
}) {
  const refreshed = lastRefreshed ? new Date(lastRefreshed) : null;
  return (
    <div className="shell">
      <aside className="sidebar">
        <h1>Factory Floor</h1>
        <p className="eyebrow">Read-only operator console</p>
        <nav aria-label="Primary">
          <NavLink to="/">Overview</NavLink>
          <NavLink to="/topology">Topology</NavLink>
          <NavLink to="/executions">Executions</NavLink>
          <NavLink to="/artifacts">Artifacts</NavLink>
          <NavLink to="/operations">Operations</NavLink>
        </nav>
        <dl className="connection-status">
          <div>
            <dt>Control plane</dt>
            <dd>
              <StatusBadge value={controlPlane} />
            </dd>
          </div>
          <div>
            <dt>Live stream</dt>
            <dd>
              <StatusBadge value={live} />
            </dd>
          </div>
        </dl>
      </aside>
      <div className="workspace">
        <header>
          <h2>{title}</h2>
          <p className="muted">
            {refreshed ? (
              <>
                Last health refresh{' '}
                <time dateTime={refreshed.toISOString()}>
                  {refreshed.toLocaleTimeString()}
                </time>
              </>
            ) : (
              'Awaiting first health check'
            )}
          </p>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}

export function DataTable({
  rows,
  cols,
  labels = {},
}: {
  rows: Record<string, unknown>[];
  cols: string[];
  labels?: Record<string, string>;
}) {
  if (rows.length === 0) return <p className="muted">No records yet.</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {cols.map((column) => (
              <th key={column} scope="col">
                {labels[column] ?? column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row.id ?? index)}>
              {cols.map((column) => (
                <td key={column}>
                  {/id$/i.test(column) ? (
                    <CopyId value={row[column]} />
                  ) : /at$/i.test(column) ? (
                    <Timestamp value={row[column]} />
                  ) : column === 'status' || column.endsWith('Status') ? (
                    <StatusBadge value={row[column]} />
                  ) : typeof row[column] === 'object' ? (
                    <JsonBlock value={row[column]} />
                  ) : (
                    String(row[column] ?? '')
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LoadMore({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
}) {
  if (!hasNextPage) return null;
  return (
    <button
      type="button"
      className="load-more"
      disabled={isFetchingNextPage}
      onClick={() => void fetchNextPage()}
    >
      {isFetchingNextPage ? 'Loading…' : 'Load more'}
    </button>
  );
}
