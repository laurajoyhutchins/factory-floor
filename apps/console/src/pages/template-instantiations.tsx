import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  consoleApi,
  type InspectionRecord,
  type Page,
} from '../api/client.js';
import {
  CopyId,
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
const text = (value: unknown, fallback = '—') =>
  value === null || value === undefined || value === ''
    ? fallback
    : String(value);

export function TemplateInstantiations() {
  const regions = useQuery({
    queryKey: ['regions', 'instantiation-scope'],
    queryFn: ({ signal }) => consoleApi.regions({ limit: 100 }, signal),
  });
  const regionItems = regions.data?.items ?? [];
  const [regionId, setRegionId] = useState('');

  useEffect(() => {
    if (!regionId && regionItems[0]?.id)
      setRegionId(String(regionItems[0].id));
  }, [regionId, regionItems]);

  const history = useInfiniteQuery({
    queryKey: ['template-instantiations', regionId],
    enabled: regionId.length > 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      consoleApi.templateInstantiations(
        { regionId },
        { cursor: pageParam, limit: 25 },
        signal,
      ),
    getNextPageParam: (lastPage: Page<InspectionRecord>) =>
      lastPage.nextCursor ?? undefined,
  });
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <State q={regions}>
        <section className="panel">
          <div className="section-heading">
            <div>
              <h3>Template instantiation history</h3>
              <p className="muted">
                Durable requests, topology outcomes, templates, and seed-state
                provenance.
              </p>
            </div>
            <label>
              Region{' '}
              <select
                aria-label="Region"
                value={regionId}
                onChange={(event) => setRegionId(event.target.value)}
              >
                {regionItems.map((region) => (
                  <option key={String(region.id)} value={String(region.id)}>
                    {text(region.name, String(region.id))}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
      </State>

      {regionItems.length === 0 && regions.data ? (
        <p className="muted">No regions are available for inspection.</p>
      ) : regionId ? (
        <State q={history}>
          <section>
            {items.length === 0 ? (
              <p className="muted">
                No template instantiations recorded for this region.
              </p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Instantiation</th>
                      <th scope="col">Request</th>
                      <th scope="col">Template</th>
                      <th scope="col">Topology revision</th>
                      <th scope="col">Disposition</th>
                      <th scope="col">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const template = record(item.template);
                      const revision = record(item.topologyRevision);
                      return (
                        <tr key={String(item.id)}>
                          <td>
                            <Link to={`/instantiations/${String(item.id)}`}>
                              {String(item.id)}
                            </Link>
                          </td>
                          <td>
                            <CopyId value={item.requestId} />
                          </td>
                          <td>{`${text(template.name)}@${text(template.version)}`}</td>
                          <td>
                            {text(revision.revisionNumber)} ·{' '}
                            <CopyId value={revision.id} />
                          </td>
                          <td>
                            <StatusBadge value={item.disposition} />
                          </td>
                          <td>
                            <Timestamp value={item.createdAt} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <LoadMore
              hasNextPage={Boolean(history.hasNextPage)}
              isFetchingNextPage={history.isFetchingNextPage}
              fetchNextPage={() => history.fetchNextPage()}
            />
          </section>
        </State>
      ) : null}
    </>
  );
}

export function TemplateInstantiationDetail() {
  const { instantiationId = '' } = useParams();
  const query = useQuery({
    queryKey: ['template-instantiation', instantiationId],
    enabled: instantiationId.length > 0,
    queryFn: ({ signal }) =>
      consoleApi.templateInstantiation(instantiationId, signal),
  });
  const value = query.data ?? {};
  const region = record(value.targetRegion);
  const revision = record(value.topologyRevision);
  const template = record(value.template);
  const initialStates = records(value.initialStates);

  return (
    <State q={query}>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h3>Template instantiation</h3>
            <p>
              <CopyId value={value.id} />{' '}
              <StatusBadge value={value.disposition} />
            </p>
          </div>
          <Link to="/instantiations">Back to history</Link>
        </div>
        <dl className="detail-grid">
          <div>
            <dt>Request</dt>
            <dd>
              <CopyId value={value.requestId} />
            </dd>
          </div>
          <div>
            <dt>Region</dt>
            <dd>
              {text(region.name)} · <CopyId value={region.id} />
            </dd>
          </div>
          <div>
            <dt>Template</dt>
            <dd>{`${text(template.name)}@${text(template.version)}`}</dd>
          </div>
          <div>
            <dt>Topology revision</dt>
            <dd>
              {text(revision.revisionNumber)} · <CopyId value={revision.id} />
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              <Timestamp value={value.createdAt} />
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h3>Request and resolution</h3>
        <h4>Parameters</h4>
        <JsonBlock value={value.parameters} />
        <h4>Component configuration</h4>
        <JsonBlock value={value.componentConfiguration} />
        <h4>Causal source</h4>
        <JsonBlock value={value.source} />
        <h4>Referenced definitions</h4>
        <JsonBlock value={value.referencedDefinitions} />
      </section>

      <section>
        <h3>Initial state provenance</h3>
        {initialStates.length === 0 ? (
          <p className="muted">
            This instantiation did not publish initial state.
          </p>
        ) : (
          initialStates.map((state) => {
            const owner = record(state.owner);
            const schema = record(state.schema);
            const artifact = record(state.artifact);
            return (
              <article key={String(state.stateVersionId)} className="panel">
                <h4>{`${text(owner.componentName)}.${text(owner.portName)}`}</h4>
                <p>
                  State version {text(state.versionNumber)} · schema{' '}
                  {`${text(schema.name)}@${text(schema.version)}`}
                </p>
                <p>
                  Artifact <CopyId value={artifact.id} /> ·{' '}
                  {text(artifact.mediaType)} ·{' '}
                  <StatusBadge value={artifact.state} />
                </p>
                <h5>Seed value</h5>
                <JsonBlock value={state.value} />
                <h5>Lineage source</h5>
                <JsonBlock value={state.source} />
                <h5>Recorded provenance</h5>
                <JsonBlock value={state.provenance} />
              </article>
            );
          })
        )}
      </section>
    </State>
  );
}
