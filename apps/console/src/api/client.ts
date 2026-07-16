export type ApiFailureKind =
  'transport' | 'http' | 'malformed-response' | 'not-found' | 'aborted';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
export type Page<T> = { items: T[]; nextCursor: string | null };
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
const paths = {
  health: '/health',
  regions: '/api/v1/inspect/regions',
  events: '/api/v1/inspect/events',
  deliveries: '/api/v1/inspect/deliveries',
  executions: '/api/v1/inspect/executions',
  attempts: '/api/v1/inspect/attempts',
  artifacts: '/api/v1/inspect/artifacts',
  resources: '/api/v1/inspect/resources',
  policies: '/api/v1/inspect/policy-decisions',
  projections: '/api/v1/inspect/projections',
  topology: '/api/v1/inspect/topology',
  stream: '/api/v1/inspect/stream',
} as const;
function pageUrl(
  path: string,
  opts: { cursor?: string | null; limit?: number } = {},
) {
  const u = new URL(path, 'http://factory-floor.local');
  if (opts.cursor) u.searchParams.set('cursor', opts.cursor);
  if (opts.limit) u.searchParams.set('limit', String(opts.limit));
  return u.pathname + u.search;
}
async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'GET',
      signal,
      headers: { accept: 'application/json' },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError')
      throw new ApiError('aborted', 'Request was cancelled.');
    throw new ApiError('transport', 'Unable to reach the control plane.');
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      if (!res.ok)
        throw new ApiError(
          'http',
          text.slice(0, 160) || res.statusText,
          res.status,
        );
      throw new ApiError(
        'malformed-response',
        'The control plane returned malformed JSON.',
        res.status,
      );
    }
  }
  if (!res.ok)
    throw new ApiError(
      res.status === 404 ? 'not-found' : 'http',
      typeof body === 'object' && body && 'error' in body
        ? JSON.stringify((body as { error: unknown }).error)
        : res.statusText,
      res.status,
    );
  return body as T;
}
function assertPage<T>(v: unknown): Page<T> {
  if (
    !v ||
    typeof v !== 'object' ||
    !Array.isArray((v as Page<T>).items) ||
    !('nextCursor' in v)
  )
    throw new ApiError(
      'malformed-response',
      'Expected a paged inspection response.',
    );
  return v as Page<T>;
}
export const consoleApi = {
  health: (signal?: AbortSignal) =>
    getJson<{ status: string; service: string }>(paths.health, signal),
  regions: (o?: { cursor?: string | null; limit?: number }, s?: AbortSignal) =>
    getJson(paths.regions && pageUrl(paths.regions, o), s).then(assertPage),
  events: (o?: { cursor?: string | null; limit?: number }, s?: AbortSignal) =>
    getJson(pageUrl(paths.events, o), s).then(assertPage),
  deliveries: (
    o?: { cursor?: string | null; limit?: number },
    s?: AbortSignal,
  ) => getJson(pageUrl(paths.deliveries, o), s).then(assertPage),
  executions: (
    o?: { cursor?: string | null; limit?: number },
    s?: AbortSignal,
  ) => getJson(pageUrl(paths.executions, o), s).then(assertPage),
  execution: (id: string, s?: AbortSignal) =>
    getJson<Record<string, unknown>>(
      `${paths.executions}/${encodeURIComponent(id)}`,
      s,
    ),
  executionAttempts: (
    id: string,
    o?: { cursor?: string | null; limit?: number },
    s?: AbortSignal,
  ) =>
    getJson(
      pageUrl(`${paths.executions}/${encodeURIComponent(id)}/attempts`, o),
      s,
    ).then(assertPage),
  attempts: (o?: { cursor?: string | null; limit?: number }, s?: AbortSignal) =>
    getJson(pageUrl(paths.attempts, o), s).then(assertPage),
  artifacts: (
    o?: { cursor?: string | null; limit?: number },
    s?: AbortSignal,
  ) => getJson(pageUrl(paths.artifacts, o), s).then(assertPage),
  artifactLineage: (id: string, s?: AbortSignal) =>
    getJson<Record<string, unknown>>(
      `${paths.artifacts}/${encodeURIComponent(id)}/lineage`,
      s,
    ),
  resources: (
    o?: { cursor?: string | null; limit?: number },
    s?: AbortSignal,
  ) => getJson(pageUrl(paths.resources, o), s).then(assertPage),
  policyDecisions: (
    o?: { cursor?: string | null; limit?: number },
    s?: AbortSignal,
  ) => getJson(pageUrl(paths.policies, o), s).then(assertPage),
  projections: (s?: AbortSignal) =>
    getJson<{ items: unknown[] }>(paths.projections, s),
  topology: (s?: AbortSignal) =>
    getJson<Record<string, unknown>>(paths.topology, s),
  streamPath: paths.stream,
};
export const readOnlyInspectionPaths = paths;
