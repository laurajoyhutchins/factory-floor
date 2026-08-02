import { useQueries } from '@tanstack/react-query';
import type {
  PortfolioClient,
  PortfolioRecord,
} from '@factory-floor/operator-client-ts/portfolio';
import { JsonBlock, StatusBadge } from '../components/ui.js';

const rec = (value: unknown): PortfolioRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as PortfolioRecord)
    : {};
const arr = (value: unknown): PortfolioRecord[] =>
  Array.isArray(value) ? value.map(rec) : [];
const text = (value: unknown, fallback: unknown = '—') =>
  value === null || value === undefined || value === ''
    ? String(fallback ?? '—')
    : String(value);
const count = (value: unknown) =>
  Number.isFinite(Number(value)) ? String(Number(value)) : '0';

function Metric({
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

function WorkSummary({ work }: { work: PortfolioRecord }) {
  const portfolio = rec(work.portfolio);
  const dependencies = rec(work.dependencies);
  const blockers = arr(work.blockers);
  return (
    <section aria-labelledby="portfolio-next-heading">
      <div className="section-heading">
        <h3 id="portfolio-next-heading">Next eligible work</h3>
        <div>
          <StatusBadge value={portfolio.priority} />{' '}
          <StatusBadge value={portfolio.route} />{' '}
          <StatusBadge value={portfolio.state ?? work.lifecycle} />
        </div>
      </div>
      <h4>{text(portfolio.title, text(portfolio.semantic_key))}</h4>
      <p>{text(portfolio.objective, text(work.next_action))}</p>
      <dl className="portfolio-facts">
        <div>
          <dt>Semantic key</dt>
          <dd>{text(portfolio.semantic_key)}</dd>
        </div>
        <div>
          <dt>Repository</dt>
          <dd>{text(portfolio.repository)}</dd>
        </div>
        <div>
          <dt>Projection revision</dt>
          <dd>{text(work.projection_sha256)}</dd>
        </div>
      </dl>
      {blockers.length ? (
        <>
          <h4>Blockers</h4>
          <JsonBlock value={blockers} />
        </>
      ) : null}
      {Object.values(dependencies).some(
        (value) => Array.isArray(value) && value.length,
      ) ? (
        <>
          <h4>Dependencies</h4>
          <JsonBlock value={dependencies} />
        </>
      ) : null}
      <h4>Source revisions</h4>
      <JsonBlock value={work.source_revisions} />
    </section>
  );
}

function ConnectedPortfolio({ client }: { client: PortfolioClient }) {
  const [status, nextWork, ownerDecisions, entities] = useQueries({
    queries: [
      {
        queryKey: ['portfolio', 'status'],
        queryFn: ({ signal }) => client.status(signal),
      },
      {
        queryKey: ['portfolio', 'next-work'],
        queryFn: ({ signal }) => client.nextWork({}, signal),
      },
      {
        queryKey: ['portfolio', 'owner-decisions'],
        queryFn: ({ signal }) => client.ownerDecisions(signal),
      },
      {
        queryKey: ['portfolio', 'entities'],
        queryFn: ({ signal }) =>
          client.entities({ entityType: 'work_item', limit: 100 }, signal),
      },
    ],
  });

  const queries = [status, nextWork, ownerDecisions, entities];
  if (queries.some((query) => query.isPending && query.data === undefined))
    return <p className="muted">Loading portfolio state…</p>;
  if (queries.some((query) => query.error))
    return (
      <div role="alert" className="error panel-state">
        <p>Unable to load portfolio state.</p>
        <button
          type="button"
          onClick={() =>
            void Promise.all(queries.map((query) => query.refetch()))
          }
        >
          Retry safe reads
        </button>
      </div>
    );

  const statusData = rec(status.data);
  const nextData = rec(nextWork.data);
  const selected = rec(nextData.work);
  const decisionItems = ownerDecisions.data?.items ?? [];
  const entityItems = entities.data?.items ?? [];
  const executable = entityItems.filter(
    (item) => item.executable === true,
  ).length;
  const blocked = entityItems.filter(
    (item) => arr(item.blockers).length > 0,
  ).length;

  return (
    <>
      <section className="cards" aria-label="Portfolio summary">
        <Metric
          title="Mode"
          value={text(statusData.mode, 'unknown')}
          detail="Read-only source-neutral projection"
        />
        <Metric
          title="Observations"
          value={count(statusData.observation_count)}
        />
        <Metric
          title="Projections"
          value={count(statusData.projection_count)}
        />
        <Metric title="Executable" value={String(executable)} />
        <Metric title="Blocked" value={String(blocked)} />
        <Metric
          title="Discrepancies"
          value={count(statusData.projections_with_discrepancies)}
        />
      </section>

      {Object.keys(selected).length ? (
        <WorkSummary work={selected} />
      ) : (
        <section aria-labelledby="portfolio-next-heading">
          <h3 id="portfolio-next-heading">Next eligible work</h3>
          <p className="muted">
            {text(nextData.reason, 'No eligible work is currently projected.')}
          </p>
        </section>
      )}

      <section aria-labelledby="portfolio-owner-heading">
        <h3 id="portfolio-owner-heading">Owner decisions</h3>
        {decisionItems.length ? (
          <div className="portfolio-list">
            {decisionItems.map((decision, index) => (
              <article key={text(decision.idempotency_key, String(index))}>
                <div className="section-heading">
                  <h4>{text(decision.summary, text(decision.category))}</h4>
                  <StatusBadge value={decision.category} />
                </div>
                <p>{text(decision.recommended_action, decision.next_action)}</p>
                <JsonBlock value={decision.source_revisions} />
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">No owner decisions.</p>
        )}
      </section>

      <section aria-labelledby="portfolio-source-heading">
        <h3 id="portfolio-source-heading">Source-backed work</h3>
        {entityItems.length ? (
          <div className="portfolio-list">
            {entityItems.map((entity) => {
              const portfolio = rec(entity.portfolio);
              return (
                <article key={text(entity.entity_key)}>
                  <div className="section-heading">
                    <h4>{text(portfolio.title, portfolio.semantic_key)}</h4>
                    <div>
                      <StatusBadge value={portfolio.route} />{' '}
                      <StatusBadge
                        value={portfolio.state ?? entity.lifecycle}
                      />
                    </div>
                  </div>
                  <p>{text(portfolio.objective, entity.next_action)}</p>
                  <JsonBlock value={entity.source_revisions} />
                </article>
              );
            })}
          </div>
        ) : (
          <p className="muted">No semantic work has been projected yet.</p>
        )}
      </section>
    </>
  );
}

export function Portfolio({ client }: { client?: PortfolioClient }) {
  if (!client)
    return (
      <div role="alert" className="panel-state">
        <p>Portfolio Control Plane is not configured for this host.</p>
        <p className="muted">
          Configure a read-only endpoint in the console host to enable this
          projection.
        </p>
      </div>
    );
  return <ConnectedPortfolio client={client} />;
}
