import { NavLink } from 'react-router';
import { shortId } from '../api/adapters.js';
export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
export function Badge({ children }: { children: React.ReactNode }) {
  return <span className="badge">{children}</span>;
}
export function CopyId({ value }: { value: unknown }) {
  const text = String(value ?? '');
  return (
    <button
      className="copy"
      onClick={() => void navigator.clipboard?.writeText(text)}
      aria-label={`Copy ${text}`}
    >
      {shortId(text)}
    </button>
  );
}
export function State({
  q,
  children,
}: {
  q: { isLoading?: boolean; error?: unknown; data?: unknown };
  children: React.ReactNode;
}) {
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.error)
    return (
      <p role="alert" className="error">
        Unable to load this panel.{' '}
        <button onClick={() => location.reload()}>Retry</button>
      </p>
    );
  if (
    Array.isArray((q.data as { items?: unknown[] })?.items) &&
    (q.data as { items: unknown[] }).items.length === 0
  )
    return <p className="muted">No records yet.</p>;
  return <>{children}</>;
}
export function Shell({
  children,
  title,
  live,
}: {
  children: React.ReactNode;
  title: string;
  live: string;
}) {
  return (
    <div className="shell">
      <aside>
        <h1>Factory Floor</h1>
        <nav aria-label="Primary">
          <NavLink to="/">Overview</NavLink>
          <NavLink to="/topology">Topology</NavLink>
          <NavLink to="/executions">Executions</NavLink>
          <NavLink to="/artifacts">Artifacts</NavLink>
          <NavLink to="/operations">Operations</NavLink>
        </nav>
        <p>
          Live stream: <Badge>{live}</Badge>
        </p>
      </aside>
      <div>
        <header>
          <h2>{title}</h2>
          <p className="muted">
            Last refreshed{' '}
            <time dateTime={new Date().toISOString()}>
              {new Date().toLocaleTimeString()}
            </time>
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
}: {
  rows: Record<string, unknown>[];
  cols: string[];
}) {
  return (
    <table>
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={String(r.id ?? i)}>
            {cols.map((c) => (
              <td key={c}>
                {/id$/i.test(c) ? (
                  <CopyId value={r[c]} />
                ) : typeof r[c] === 'object' ? (
                  <JsonBlock value={r[c]} />
                ) : (
                  String(r[c] ?? '')
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
